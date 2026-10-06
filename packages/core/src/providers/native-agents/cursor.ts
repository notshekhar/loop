import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { cachedProbe, peekProbe } from "./probe-cache";
import { findExecutable, runCommand, spawnJsonLines } from "./process";
import { mapCursorTool } from "./tool-map";
import {
    type Effort,
    EFFORT_ORDER,
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
 * Cursor as an ai-sdk provider, driving the user's `cursor-agent` CLI in
 * headless mode (`-p --output-format stream-json`). The CLI's own login (or
 * CURSOR_API_KEY) authenticates; loop stores nothing.
 */
// Not plain "cursor": the desktop/web app inherits t3code's own `cursor`
// driver (default model, slug aliases, a settings block that defaults to
// disabled), and sharing its id silently hid every model from the picker.
export const CURSOR_PROVIDER = "cursor-agent" as const;

export function findCursorBinary(): string | undefined {
    return findExecutable(["cursor-agent"], "CURSOR_AGENT_BIN");
}

// ---- model families ----------------------------------------------------------

/**
 * Cursor lists every effort/thinking/speed combination as its own model id
 * (claude-opus-4-8-thinking-high-fast, gpt-5.5-extra-high, …). Loop has one
 * thinking-level control, so variants are grouped into families — one model
 * in loop's picker — and the variant is chosen per call from the level.
 */
export interface CursorVariant {
    id: string;
    name: string;
    /** Effort token in the id; "default" when the id carries none. */
    effort: Effort | "default";
    thinking: boolean;
}

export interface CursorFamily {
    /** loop model id (after "cursor-agent/"): base id, plus "-fast" for fast variants. */
    id: string;
    name: string;
    variants: CursorVariant[];
    /** More than one reasoning setting to choose between. */
    reasoning: boolean;
}

const EFFORT_TOKENS: Record<string, Effort> = {
    none: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
};

export function parseCursorVariant(id: string, name: string): { familyId: string; variant: CursorVariant } {
    const t = id.split("-");
    let fast = false;
    let thinking = false;
    let effort: Effort | "default" = "default";
    if (t.length > 1 && t.at(-1) === "fast") {
        fast = true;
        t.pop();
    }
    if (t.length > 1 && t.at(-1) === "thinking") {
        thinking = true;
        t.pop();
    }
    if (t.length > 2 && t.at(-2) === "extra" && t.at(-1) === "high") {
        effort = "xhigh";
        t.splice(-2);
    } else if (t.length > 1 && EFFORT_TOKENS[t.at(-1)!]) {
        effort = EFFORT_TOKENS[t.pop()!];
    }
    if (t.length > 1 && t.at(-1) === "thinking") {
        thinking = true;
        t.pop();
    }
    const base = t.join("-");
    return { familyId: fast ? `${base}-fast` : base, variant: { id, name, effort, thinking } };
}

const EFFORT_WORDS = /\b(none|minimal|low|medium|high|extra high|xhigh|max|thinking)\b/gi;

export function groupCursorModels(models: Array<{ id: string; name: string }>): CursorFamily[] {
    const families = new Map<string, CursorVariant[]>();
    for (const m of models) {
        const { familyId, variant } = parseCursorVariant(m.id, m.name);
        const list = families.get(familyId) ?? [];
        list.push(variant);
        families.set(familyId, list);
    }
    return [...families.entries()].map(([id, variants]) => {
        const representative = variants.find((v) => v.effort === "default") ?? variants[0];
        const name = representative.name.replace(EFFORT_WORDS, "").replace(/\s{2,}/g, " ").trim() || id;
        const settings = new Set(variants.map((v) => `${v.effort}/${v.thinking}`));
        return { id, name, variants, reasoning: settings.size > 1 || variants.some((v) => v.thinking) };
    });
}

const rankOf = (v: CursorVariant): Effort => (v.effort === "default" ? "medium" : v.effort);

/**
 * Pick the variant for loop's thinking level: thinking variants when thinking
 * is on (non-thinking when off), then the nearest effort. With no level
 * requested, the family's plain default (or its middle) is used.
 */
export function selectCursorVariant(family: CursorFamily, effort: Effort | undefined): CursorVariant {
    const { variants } = family;
    if (variants.length === 1) return variants[0];
    if (effort === undefined) {
        return (
            variants.find((v) => v.effort === "default" && !v.thinking) ??
            pickNearest(variants.filter((v) => v.thinking).length ? variants.filter((v) => v.thinking) : variants, "medium")
        );
    }
    const wantThinking = effort !== "none";
    const hasThinkingSplit = variants.some((v) => v.thinking) && variants.some((v) => !v.thinking);
    const pool = hasThinkingSplit ? variants.filter((v) => v.thinking === wantThinking) : variants;
    return pickNearest(pool.length ? pool : variants, effort);
}

function pickNearest(pool: CursorVariant[], target: Effort): CursorVariant {
    const chosen = nearestEffort(target, [...new Set(pool.map(rankOf))]);
    const matches = pool.filter((v) => rankOf(v) === chosen);
    // Prefer an explicit effort over the unnamed default at the same rank.
    return matches.find((v) => v.effort !== "default") ?? matches[0] ?? pool[0];
}

// ---- detection ---------------------------------------------------------------

export interface CursorProbe {
    binary: string;
    loggedIn: boolean;
    account?: string;
    families: CursorFamily[];
}

const PROBE_KEY = CURSOR_PROVIDER;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export async function probeCursor(opts: { refresh?: boolean } = {}): Promise<CursorProbe | null> {
    const binary = findCursorBinary();
    if (!binary) return null;
    return cachedProbe<CursorProbe | null>(PROBE_KEY, async () => {
        const status = await runCommand(binary, ["status"], { timeoutMs: 15_000 });
        const statusText = (status.stdout + status.stderr).replace(ANSI, "");
        const login = /logged in as\s+(\S+)/i.exec(statusText);
        const loggedIn = Boolean(login) || Boolean(process.env.CURSOR_API_KEY);
        if (!loggedIn) return { binary, loggedIn: false, families: [] };
        const list = await runCommand(binary, ["--list-models"], { timeoutMs: 30_000 });
        const models: Array<{ id: string; name: string }> = [];
        for (const raw of list.stdout.replace(ANSI, "").split("\n")) {
            const m = /^\s*([A-Za-z0-9][\w.\-\[\]=,]*)\s+-\s+(.+?)\s*$/.exec(raw);
            if (!m) continue;
            // Zero-width characters ride along in some display names.
            const name = m[2].replace(/\((current|default)[^)]*\)/gi, "").replace(/[​-‍﻿]/g, "").trim();
            models.push({ id: m[1], name });
        }
        return { binary, loggedIn: true, account: login?.[1], families: groupCursorModels(models) };
    }, opts);
}

function familyFor(modelId: string): CursorFamily | undefined {
    return peekProbe<CursorProbe | null>(PROBE_KEY)?.families.find((f) => f.id === modelId);
}

/** The concrete `--model` value for a loop model id + thinking level. */
export function resolveCursorModel(modelId: string, effort: Effort | undefined): string {
    const family = familyFor(modelId);
    return family ? selectCursorVariant(family, effort).id : modelId;
}

// ---- stream-json → ai-sdk ----------------------------------------------------

/** `{ shellToolCall: {...} }` → kind `shell` and its payload. */
function toolKindOf(call: Record<string, unknown>): { kind: string; body: Record<string, unknown> } {
    const key = Object.keys(call).find((k) => k.endsWith("ToolCall")) ?? Object.keys(call)[0] ?? "tool";
    return { kind: key.replace(/ToolCall$/, ""), body: (call[key] ?? {}) as Record<string, unknown> };
}

const NOISY_ARG_KEYS = new Set([
    "toolCallId",
    "parsingResult",
    "simpleCommands",
    "hasInputRedirect",
    "hasOutputRedirect",
    "hookAdditionalContexts",
]);

function cleanArgs(args: unknown): unknown {
    if (!args || typeof args !== "object") return args ?? {};
    return Object.fromEntries(Object.entries(args).filter(([k]) => !NOISY_ARG_KEYS.has(k)));
}

function toolResultOf(name: string, body: Record<string, unknown>): { value: unknown; isError: boolean } {
    const result = (body.result ?? {}) as Record<string, unknown>;
    if (result.error !== undefined || result.failure !== undefined || result.rejected !== undefined) {
        return { value: result.error ?? result.failure ?? result.rejected, isError: true };
    }
    const success = (result.success ?? result) as Record<string, unknown>;
    if (name === "shell" && typeof success === "object") {
        const out = String(success.stdout ?? "");
        const err = String(success.stderr ?? "");
        const code = Number(success.exitCode ?? 0);
        return {
            value: `${out}${err ? `${out ? "\n" : ""}[stderr]\n${err}` : ""}${code ? `\n[exit ${code}]` : ""}`,
            isError: code !== 0,
        };
    }
    if (success && typeof success === "object") {
        const { interleavedOutput: _drop, ...rest } = success;
        return { value: rest, isError: false };
    }
    return { value: success ?? "", isError: false };
}

// ---- the model ---------------------------------------------------------------

export class CursorLanguageModel implements LanguageModelV4 {
    readonly specificationVersion = "v4" as const;
    readonly provider = CURSOR_PROVIDER;
    readonly supportedUrls = {};

    constructor(readonly modelId: string) {}

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
        return generateFromStream(await this.doStream(options));
    }

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
        const binary = findCursorBinary();
        if (!binary) throw new Error("Cursor's CLI is not installed (no `cursor-agent` on PATH). Install it, then run `cursor-agent login`.");
        const ctx = readTurnContext(options, CURSOR_PROVIDER);
        const link = ctx ? getSessionLink(CURSOR_PROVIDER, ctx.loopSessionId) : undefined;
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
        const variant = resolveCursorModel(this.modelId, requestedEffort(options));
        const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust", "--model", variant];
        if (plan.resumeId) args.push("--resume", plan.resumeId);
        if (!ctx) args.push("--mode", "ask");
        else if (ctx.planMode) args.push("--mode", "plan");
        else if (ctx.approvals) args.push("--auto-review");
        else args.push("--force");
        if (ctx) args.push("--workspace", ctx.cwd);

        // No system-prompt flag: utility calls carry their instructions inline.
        const system = ctx
            ? ""
            : options.prompt
                  .filter((m) => m.role === "system")
                  .map((m) => m.content as string)
                  .join("\n\n");
        const imageNote = plan.images.length ? `\n\n[${plan.images.length} image(s) attached — not supported by Cursor's CLI]` : "";
        const stdin = `${system ? `${system}\n\n` : ""}${plan.text}${imageNote}`;

        const w = new PartWriter(enqueue, CURSOR_PROVIDER);
        const toolNames = new Map<string, string>();
        let producedOutput = false;
        let finished = false;
        let exit: { code: number | null; stderr: string } | undefined;
        let sessionId = plan.resumeId;

        // One cursor-agent process per loop session at a time — see waitForPreviousTurn.
        const gateKey = ctx ? `${CURSOR_PROVIDER}:${ctx.loopSessionId}` : undefined;
        await waitForPreviousTurn(gateKey);
        for await (const ev of spawnJsonLines(binary, args, {
            cwd: ctx?.cwd,
            stdin,
            signal: options.abortSignal,
            onExit: (code, stderr) => (exit = { code, stderr }),
            onSpawn: (exited) => trackTurnProcess(gateKey, exited),
        })) {
            const type = ev.type as string;
            const subtype = ev.subtype as string | undefined;
            if (type === "system" && subtype === "init") {
                sessionId = String(ev.session_id);
                if (ctx) {
                    setSessionLink(CURSOR_PROVIDER, ctx.loopSessionId, {
                        nativeId: sessionId,
                        seen: plan.seen,
                        model: this.modelId,
                        updatedAt: Date.now(),
                    });
                }
                enqueue({ type: "response-metadata", id: sessionId, modelId: variant });
            } else if (type === "thinking") {
                if (subtype === "delta") w.reasoning(String(ev.text ?? ""));
                else if (subtype === "completed") w.endReasoning();
                producedOutput = true;
            } else if (type === "assistant") {
                // Deltas carry a timestamp; the consolidated copy of each
                // segment (model_call_id, or no timestamp) closes it instead.
                const text = ((ev.message as { content?: Array<{ text?: string }> })?.content ?? [])
                    .map((c) => c.text ?? "")
                    .join("");
                if (ev.model_call_id !== undefined || ev.timestamp_ms === undefined) w.endText();
                else w.text(text);
                producedOutput = true;
            } else if (type === "tool_call") {
                const id = String(ev.call_id ?? "").replace(/\s+/g, "_");
                const { kind, body } = toolKindOf((ev.tool_call ?? {}) as Record<string, unknown>);
                const mapped = mapCursorTool(kind, cleanArgs(body.args));
                if (subtype === "started") {
                    toolNames.set(id, mapped.name);
                    w.toolCall(id, mapped.name, mapped.input);
                } else if (subtype === "completed") {
                    if (!toolNames.has(id)) w.toolCall(id, mapped.name, mapped.input);
                    const { value, isError } = toolResultOf(kind, body);
                    w.toolResult(id, toolNames.get(id) ?? mapped.name, value, isError);
                }
                producedOutput = true;
            } else if (type === "result") {
                w.endAll();
                const isError = ev.is_error === true || subtype !== "success";
                if (isError) enqueue({ type: "error", error: new Error(`Cursor: ${String(ev.result ?? ev.error ?? subtype)}`) });
                const u = (ev.usage ?? {}) as Record<string, number>;
                const cacheRead = u.cacheReadTokens ?? 0;
                const cacheWrite = u.cacheWriteTokens ?? 0;
                enqueue({
                    type: "finish",
                    usage: makeUsage({
                        input: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite),
                        cacheRead,
                        cacheWrite,
                        output: u.outputTokens,
                    }),
                    finishReason: finishReason(isError ? "error" : "stop", subtype),
                    providerMetadata: {
                        [CURSOR_PROVIDER]: { sessionId: sessionId ?? null, model: variant, requestId: (ev.request_id as string) ?? null },
                    },
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
        const detail = exit?.stderr.replace(ANSI, "").trim() || `cursor-agent exited with code ${exit?.code ?? "?"}`;
        if (!producedOutput && plan.resumeId) return "missing-session";
        throw new Error(`Cursor: ${detail}`);
    }
}

export function createCursorModel(modelId: string): LanguageModelV4 {
    return new CursorLanguageModel(modelId);
}

/** For the catalog: the efforts a family can express, strongest last. */
export function familyEfforts(family: CursorFamily): Effort[] {
    return EFFORT_ORDER.filter((e) => family.variants.some((v) => rankOf(v) === e));
}
