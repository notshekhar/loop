import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { groupCursorModels, selectCursorVariant, type CursorFamily } from "./cursor";
import { cachedProbe, peekProbe } from "./probe-cache";
import { findExecutable, runCommand, spawnJsonLines } from "./process";
import { mapAntigravityTool } from "./tool-map";
import {
    type Effort,
    finishReason,
    generateFromStream,
    getSessionLink,
    makeUsage,
    PartWriter,
    planPrompt,
    type PromptPlan,
    readTurnContext,
    requestedEffort,
    setSessionLink,
    stringify,
    streamFrom,
    trackTurnProcess,
    waitForPreviousTurn,
    type NativeAgentTurnContext,
} from "./shared";

/**
 * Google's Antigravity as an ai-sdk provider, driving the user's `agy` CLI in
 * print mode (`-p --output-format stream-json`). The CLI's own sign-in
 * authenticates; loop stores nothing.
 */
export const ANTIGRAVITY_PROVIDER = "antigravity" as const;

export function findAntigravityBinary(): string | undefined {
    return findExecutable(["agy"], "ANTIGRAVITY_BIN");
}

// ---- detection ---------------------------------------------------------------

/**
 * Like Cursor, `agy models` lists every effort as its own id
 * (gemini-3.8-flash-high, -medium, -low), so the same family grouping applies:
 * one model in loop's picker, the variant chosen from the thinking level.
 */
export type AntigravityFamily = CursorFamily;

export interface AntigravityProbe {
    binary: string;
    loggedIn: boolean;
    families: AntigravityFamily[];
}

const PROBE_KEY = ANTIGRAVITY_PROVIDER;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `agy models` prints `id<TAB>Display name` per model, after a banner line. */
export function parseAntigravityModels(stdout: string): Array<{ id: string; name: string }> {
    const models: Array<{ id: string; name: string }> = [];
    for (const raw of stdout.replace(ANSI, "").split("\n")) {
        const m = /^([A-Za-z0-9][\w.\-]*)\t+(.+?)\s*$/.exec(raw);
        if (m) models.push({ id: m[1], name: m[2] });
    }
    return models;
}

export async function probeAntigravity(opts: { refresh?: boolean } = {}): Promise<AntigravityProbe | null> {
    const binary = findAntigravityBinary();
    if (!binary) return null;
    return cachedProbe<AntigravityProbe | null>(PROBE_KEY, async () => {
        // No status command: listing the account's models needs the sign-in,
        // so a list is the proof of one.
        const list = await runCommand(binary, ["models"], { timeoutMs: 30_000 });
        const models = list.code === 0 ? parseAntigravityModels(list.stdout) : [];
        if (models.length === 0) return { binary, loggedIn: false, families: [] };
        return { binary, loggedIn: true, families: groupCursorModels(models) };
    }, opts);
}

function familyFor(modelId: string): AntigravityFamily | undefined {
    return peekProbe<AntigravityProbe | null>(PROBE_KEY)?.families.find((f) => f.id === modelId);
}

/** The concrete `--model` value for a loop model id + thinking level. */
export function resolveAntigravityModel(modelId: string, effort: Effort | undefined): string {
    const family = familyFor(modelId);
    return family ? selectCursorVariant(family, effort).id : modelId;
}

// ---- argv --------------------------------------------------------------------

/**
 * The command line for one turn. agy parses flags Go-style, so the prompt
 * rides as `--print=<text>`: a prompt starting with "-" stays a prompt.
 */
export function antigravityArgs(input: {
    model: string;
    prompt: string;
    resumeId?: string;
    ctx?: NativeAgentTurnContext;
}): string[] {
    const args = [`--print=${input.prompt}`, "--output-format", "stream-json", "--model", input.model, "--disable-slash-commands"];
    if (input.resumeId) args.push("--conversation", input.resumeId);
    const { ctx } = input;
    if (!ctx || ctx.planMode) args.push("--mode", "plan");
    // Print mode cannot ask; "auto" lets agy decide what is safe to run.
    else if (ctx.approvals) args.push("--mode", "auto");
    else args.push("--dangerously-skip-permissions");
    return args;
}

// ---- the model ---------------------------------------------------------------

export class AntigravityLanguageModel implements LanguageModelV4 {
    readonly specificationVersion = "v4" as const;
    readonly provider = ANTIGRAVITY_PROVIDER;
    readonly supportedUrls = {};

    constructor(readonly modelId: string) {}

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
        return generateFromStream(await this.doStream(options));
    }

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
        const binary = findAntigravityBinary();
        if (!binary) throw new Error("Antigravity's CLI is not installed (no `agy` on PATH). Install it, then sign in by running `agy`.");
        const ctx = readTurnContext(options, ANTIGRAVITY_PROVIDER);
        const link = ctx ? getSessionLink(ANTIGRAVITY_PROVIDER, ctx.loopSessionId) : undefined;
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
        const variant = resolveAntigravityModel(this.modelId, requestedEffort(options));
        const system = ctx
            ? ""
            : options.prompt
                  .filter((m) => m.role === "system")
                  .map((m) => m.content as string)
                  .join("\n\n");
        const imageNote = plan.images.length ? `\n\n[${plan.images.length} image(s) attached — not supported by Antigravity's CLI]` : "";
        const prompt = `${system ? `${system}\n\n` : ""}${plan.text}${imageNote}`;
        const args = antigravityArgs({ model: variant, prompt, resumeId: plan.resumeId, ctx });

        const w = new PartWriter(enqueue, ANTIGRAVITY_PROVIDER);
        const toolNames = new Map<string, string>();
        let producedOutput = false;
        let finished = false;
        let exit: { code: number | null; stderr: string } | undefined;
        let sessionId = plan.resumeId;

        const gateKey = ctx ? `${ANTIGRAVITY_PROVIDER}:${ctx.loopSessionId}` : undefined;
        await waitForPreviousTurn(gateKey);
        for await (const ev of spawnJsonLines(binary, args, {
            cwd: ctx?.cwd,
            signal: options.abortSignal,
            onExit: (code, stderr) => (exit = { code, stderr }),
            onSpawn: (exited) => trackTurnProcess(gateKey, exited),
        })) {
            const kind = ev.event as string;
            if (kind === "init") {
                sessionId = String(ev.conversation_id);
                if (ctx) {
                    setSessionLink(ANTIGRAVITY_PROVIDER, ctx.loopSessionId, {
                        nativeId: sessionId,
                        seen: plan.seen,
                        model: this.modelId,
                        updatedAt: Date.now(),
                    });
                }
                enqueue({ type: "response-metadata", id: sessionId, modelId: variant });
            } else if (kind === "step_update") {
                const step = (ev.step_update ?? {}) as Record<string, unknown>;
                const state = String(step.state ?? "");
                if (step.step_type === "agent_response") {
                    if (typeof step.thinking_delta === "string") w.reasoning(step.thinking_delta);
                    if (typeof step.text_delta === "string") {
                        w.text(step.text_delta);
                        producedOutput = true;
                    }
                    if (state === "DONE" || state === "ERROR") w.endAll();
                } else if (step.step_type === "tool") {
                    const id = `agy-${sessionId ?? "turn"}-${String(step.step_index ?? "")}`;
                    const info = (step.tool_info ?? {}) as Record<string, unknown>;
                    const name = String(step.tool_name ?? info.name ?? "tool");
                    const mapped = mapAntigravityTool(name, info.parameters);
                    if (!toolNames.has(id)) {
                        toolNames.set(id, mapped.name);
                        w.toolCall(id, mapped.name, mapped.input);
                    }
                    if (state === "DONE") w.toolResult(id, mapped.name, info.output ?? "", false);
                    else if (state === "ERROR") {
                        const error = info.error as { message?: unknown } | undefined;
                        w.toolResult(id, mapped.name, String(error?.message ?? "failed"), true);
                    }
                    producedOutput = true;
                }
            } else if (kind === "result") {
                w.endAll();
                const result = (ev.result ?? {}) as Record<string, unknown>;
                const ok = result.status === "SUCCESS";
                const denied = Array.isArray(result.denied_actions) ? (result.denied_actions as Array<{ display_name?: string }>) : [];
                if (!ok) enqueue({ type: "error", error: new Error(`Antigravity: ${stringify(result.error ?? result.status ?? "the turn failed")}`) });
                else if (denied.length && !producedOutput) {
                    // Plan mode and print mode cannot approve: say what was refused instead of an empty reply.
                    w.text(`Antigravity was not allowed to run: ${denied.map((d) => d.display_name ?? "a tool").join(", ")}.`);
                    w.endText();
                }
                const u = (result.usage ?? {}) as Record<string, number>;
                const cacheRead = u.cache_read_tokens ?? 0;
                enqueue({
                    type: "finish",
                    usage: makeUsage({
                        input: Math.max(0, (u.input_tokens ?? 0) - cacheRead),
                        cacheRead,
                        output: u.output_tokens,
                        reasoning: u.thinking_tokens,
                    }),
                    finishReason: finishReason(ok ? "stop" : "error", String(result.status ?? "")),
                    providerMetadata: { [ANTIGRAVITY_PROVIDER]: { sessionId: sessionId ?? null, model: variant } },
                });
                finished = true;
            }
        }

        if (finished) return "done";
        w.endAll();
        if (options.abortSignal?.aborted) {
            enqueue({ type: "finish", usage: makeUsage({}), finishReason: finishReason("other", "aborted") });
            return "done";
        }
        if (!producedOutput && plan.resumeId) return "missing-session";
        const detail = exit?.stderr.replace(ANSI, "").trim() || `agy exited with code ${exit?.code ?? "?"}`;
        throw new Error(`Antigravity: ${detail}`);
    }
}

export function createAntigravityModel(modelId: string): LanguageModelV4 {
    return new AntigravityLanguageModel(modelId);
}
