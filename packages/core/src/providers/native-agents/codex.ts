import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedProbe, peekProbe } from "./probe-cache";
import { findExecutable, runCommand, spawnJsonLines } from "./process";
import { mapCodexItem } from "./tool-map";
import {
    type Effort,
    finishReason,
    generateFromStream,
    getSessionLink,
    makeUsage,
    nearestEffort,
    PartWriter,
    planPrompt,
    type PromptPlan,
    readTurnContext,
    requestedEffort,
    setSessionLink,
    streamFrom,
    trackTurnProcess,
    waitForPreviousTurn,
    type NativeAgentTurnContext,
} from "./shared";

/**
 * OpenAI's Codex as an ai-sdk provider, driving the user's `codex` CLI in
 * headless mode (`codex exec --json`). The CLI's own login (ChatGPT or an API
 * key) authenticates; loop stores nothing.
 */
// Not plain "codex": the desktop/web app inherits t3code's own `codex` driver
// kind, and sharing its id hides the models the same way it did for Cursor.
export const CODEX_PROVIDER = "codex-cli" as const;

export function findCodexBinary(): string | undefined {
    return findExecutable(["codex"], "CODEX_BIN");
}

// ---- detection ---------------------------------------------------------------

export interface CodexModel {
    slug: string;
    name: string;
    contextWindow?: number;
    efforts: Effort[];
    defaultEffort?: Effort;
    images: boolean;
}

export interface CodexProbe {
    binary: string;
    loggedIn: boolean;
    /** How the CLI is signed in ("ChatGPT", "an API key"), as it reports it. */
    account?: string;
    models: CodexModel[];
}

const PROBE_KEY = CODEX_PROVIDER;
const EFFORTS = new Set<string>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** `codex debug models` → the models the picker should offer. */
export function parseCodexModels(json: string): CodexModel[] {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return [];
    }
    const list = (Array.isArray(raw) ? raw : ((raw as { models?: unknown })?.models ?? [])) as Array<Record<string, unknown>>;
    if (!Array.isArray(list)) return [];
    const out: CodexModel[] = [];
    for (const m of list) {
        const slug = typeof m.slug === "string" ? m.slug : undefined;
        // Hidden ones are internal (auto-review, reserve capacity), not choices.
        if (!slug || (m.visibility !== undefined && m.visibility !== "list")) continue;
        const levels = Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as Array<{ effort?: unknown }>) : [];
        const efforts = levels.map((l) => String(l.effort)).filter((e): e is Effort => EFFORTS.has(e));
        const def = typeof m.default_reasoning_level === "string" && EFFORTS.has(m.default_reasoning_level) ? (m.default_reasoning_level as Effort) : undefined;
        out.push({
            slug,
            name: typeof m.display_name === "string" && m.display_name ? m.display_name : slug,
            ...(typeof m.context_window === "number" && m.context_window > 0 ? { contextWindow: m.context_window } : {}),
            efforts,
            ...(def ? { defaultEffort: def } : {}),
            images: Array.isArray(m.input_modalities) && (m.input_modalities as unknown[]).includes("image"),
        });
    }
    return out;
}

export async function probeCodex(opts: { refresh?: boolean } = {}): Promise<CodexProbe | null> {
    const binary = findCodexBinary();
    if (!binary) return null;
    return cachedProbe<CodexProbe | null>(PROBE_KEY, async () => {
        const status = await runCommand(binary, ["login", "status"], { timeoutMs: 15_000 });
        const statusText = `${status.stdout}\n${status.stderr}`;
        const login = /logged in using\s+(.+)/i.exec(statusText);
        const loggedIn = status.code === 0 && Boolean(login);
        if (!loggedIn) return { binary, loggedIn: false, models: [] };
        const list = await runCommand(binary, ["debug", "models"], { timeoutMs: 30_000 });
        return { binary, loggedIn: true, account: login?.[1]?.trim(), models: parseCodexModels(list.stdout) };
    }, opts);
}

function modelFor(slug: string): CodexModel | undefined {
    return peekProbe<CodexProbe | null>(PROBE_KEY)?.models.find((m) => m.slug === slug);
}

/** The `model_reasoning_effort` to ask for, or undefined to leave Codex's default. */
export function codexEffort(model: CodexModel | undefined, requested: Effort | undefined): Effort | undefined {
    if (requested === undefined) return undefined;
    if (!model || model.efforts.length === 0) return requested === "none" ? undefined : requested;
    return nearestEffort(requested, model.efforts);
}

// ---- argv --------------------------------------------------------------------

/**
 * The command line for one turn. Kept pure for tests: everything the CLI is
 * told about permissions, model and session lives here.
 *
 * `exec resume` takes no --sandbox or --cd, so the sandbox goes through `-c`
 * (it works for both) and the directory is the process's own cwd.
 */
export function codexArgs(input: {
    model: string;
    effort?: Effort;
    resumeId?: string;
    ctx?: NativeAgentTurnContext;
    images?: readonly string[];
}): string[] {
    const args = ["exec"];
    if (input.resumeId) args.push("resume");
    args.push("--json", "--skip-git-repo-check", "-m", input.model);
    if (input.effort) args.push("-c", `model_reasoning_effort="${input.effort}"`);
    const { ctx } = input;
    if (!ctx) {
        // A utility call (title, recap, summary): no tools worth running, no session kept.
        args.push("-c", 'sandbox_mode="read-only"', "--ephemeral");
    } else if (ctx.planMode) {
        args.push("-c", 'sandbox_mode="read-only"');
    } else if (ctx.approvals) {
        // Headless Codex cannot ask; the sandbox is the closest thing to "ask first".
        args.push("-c", 'sandbox_mode="workspace-write"');
    } else {
        args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    for (const image of input.images ?? []) args.push("-i", image);
    if (input.resumeId) args.push(input.resumeId);
    // The prompt arrives on stdin.
    args.push("-");
    return args;
}

// ---- the model ---------------------------------------------------------------

export class CodexLanguageModel implements LanguageModelV4 {
    readonly specificationVersion = "v4" as const;
    readonly provider = CODEX_PROVIDER;
    readonly supportedUrls = {};

    constructor(readonly modelId: string) {}

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
        return generateFromStream(await this.doStream(options));
    }

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
        const binary = findCodexBinary();
        if (!binary) throw new Error("Codex is not installed (no `codex` on PATH). Install it, then run `codex login`.");
        const ctx = readTurnContext(options, CODEX_PROVIDER);
        const link = ctx ? getSessionLink(CODEX_PROVIDER, ctx.loopSessionId) : undefined;
        const plan = planPrompt(options.prompt, link, this.modelId);
        return streamFrom(async (enqueue) => {
            const outcome = await this.runTurn(binary, options, ctx, plan, enqueue);
            if (outcome === "missing-session") {
                await this.runTurn(binary, options, ctx, planPrompt(options.prompt, undefined, this.modelId), enqueue);
            }
        });
    }

    private async runTurn(
        binary: string,
        options: LanguageModelV4CallOptions,
        ctx: NativeAgentTurnContext | undefined,
        plan: PromptPlan,
        enqueue: (part: LanguageModelV4StreamPart) => void,
    ): Promise<"done" | "missing-session"> {
        const model = modelFor(this.modelId);
        const effort = codexEffort(model, requestedEffort(options));
        // Codex reads images from files; they live only as long as the turn.
        const imageDir = plan.images.length ? mkdtempSync(join(tmpdir(), "loop-codex-")) : undefined;
        const images = plan.images.map((img, i) => {
            const ext = img.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
            const path = join(imageDir!, `image-${i}.${ext}`);
            writeFileSync(path, Buffer.from(img.base64, "base64"));
            return path;
        });
        const args = codexArgs({ model: this.modelId, effort, resumeId: plan.resumeId, ctx, images });

        // No system-prompt flag: utility calls carry their instructions inline.
        const system = ctx
            ? ""
            : options.prompt
                  .filter((m) => m.role === "system")
                  .map((m) => m.content as string)
                  .join("\n\n");
        const stdin = `${system ? `${system}\n\n` : ""}${plan.text}`;

        const w = new PartWriter(enqueue, CODEX_PROVIDER);
        const toolNames = new Map<string, string>();
        let producedOutput = false;
        let finished = false;
        let failure: string | undefined;
        let exit: { code: number | null; stderr: string } | undefined;
        let sessionId = plan.resumeId;

        const gateKey = ctx ? `${CODEX_PROVIDER}:${ctx.loopSessionId}` : undefined;
        await waitForPreviousTurn(gateKey);
        try {
            for await (const ev of spawnJsonLines(binary, args, {
                cwd: ctx?.cwd,
                stdin,
                signal: options.abortSignal,
                onExit: (code, stderr) => (exit = { code, stderr }),
                onSpawn: (exited) => trackTurnProcess(gateKey, exited),
            })) {
                const type = ev.type as string;
                if (type === "thread.started") {
                    sessionId = String(ev.thread_id);
                    if (ctx) {
                        setSessionLink(CODEX_PROVIDER, ctx.loopSessionId, {
                            nativeId: sessionId,
                            seen: plan.seen,
                            model: this.modelId,
                            updatedAt: Date.now(),
                        });
                    }
                    enqueue({ type: "response-metadata", id: sessionId, modelId: this.modelId });
                } else if (type === "item.started" || type === "item.updated" || type === "item.completed") {
                    const item = (ev.item ?? {}) as Record<string, unknown>;
                    const id = `codex-${String(item.id ?? "")}`;
                    const kind = String(item.type ?? "");
                    if (kind === "agent_message") {
                        if (type === "item.completed") {
                            w.text(String(item.text ?? ""));
                            w.endText();
                            producedOutput = true;
                        }
                    } else if (kind === "reasoning") {
                        if (type === "item.completed") {
                            w.reasoning(String(item.text ?? ""));
                            w.endReasoning();
                            producedOutput = true;
                        }
                    } else if (kind === "error") {
                        // A non-fatal warning from the agent; the turn carries on.
                        if (type === "item.completed" && item.message) w.reasoning(`⚠ ${String(item.message)}\n`);
                    } else {
                        const mapped = mapCodexItem(item);
                        if (!toolNames.has(id)) {
                            toolNames.set(id, mapped.name);
                            w.toolCall(id, mapped.name, mapped.input);
                        }
                        if (type === "item.completed") w.toolResult(id, mapped.name, mapped.result ?? "", mapped.isError === true);
                        producedOutput = true;
                    }
                } else if (type === "turn.completed") {
                    w.endAll();
                    const u = (ev.usage ?? {}) as Record<string, number>;
                    const cached = u.cached_input_tokens ?? 0;
                    const cacheWrite = u.cache_write_input_tokens ?? 0;
                    enqueue({
                        type: "finish",
                        usage: makeUsage({
                            // Codex's input_tokens already include the cached share.
                            input: Math.max(0, (u.input_tokens ?? 0) - cached - cacheWrite),
                            cacheRead: cached,
                            cacheWrite,
                            output: u.output_tokens,
                            reasoning: u.reasoning_output_tokens,
                        }),
                        finishReason: finishReason("stop"),
                        providerMetadata: { [CODEX_PROVIDER]: { sessionId: sessionId ?? null, model: this.modelId } },
                    });
                    finished = true;
                } else if (type === "turn.failed") {
                    failure = String((ev.error as { message?: unknown })?.message ?? "the turn failed");
                } else if (type === "error") {
                    failure = String(ev.message ?? "unknown error");
                }
            }
        } finally {
            if (imageDir) rmSync(imageDir, { recursive: true, force: true });
        }

        if (finished) return "done";
        w.endAll();
        if (options.abortSignal?.aborted) {
            enqueue({ type: "finish", usage: makeUsage({}), finishReason: finishReason("other", "aborted") });
            return "done";
        }
        if (!producedOutput && plan.resumeId) return "missing-session";
        const detail = failure ?? (exit?.stderr.trim() || `codex exited with code ${exit?.code ?? "?"}`);
        throw new Error(`Codex: ${detail}`);
    }
}

export function createCodexModel(modelId: string): LanguageModelV4 {
    return new CodexLanguageModel(modelId);
}
