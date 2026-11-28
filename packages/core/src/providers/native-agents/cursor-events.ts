import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { JsonLinesReader } from "./json-lines-turn";
import { mapCursorTool } from "./tool-map";
import { finishReason, linkNativeSession, makeUsage, PartWriter, type NativeAgentTurnContext, type PromptPlan } from "./shared";

// Not plain "cursor": the desktop/web app inherits t3code's own `cursor`
// driver (default model, slug aliases, a settings block that defaults to
// disabled), and sharing its id silently hid every model from the picker.
export const CURSOR_PROVIDER = "cursor-agent" as const;

/** Turns one `cursor-agent -p --output-format stream-json` turn into ai-sdk stream parts. */
export class CursorTurnReader implements JsonLinesReader {
    finished = false;
    producedOutput = false;
    private sessionId: string | undefined;
    private readonly w: PartWriter;
    private readonly toolNames = new Map<string, string>();

    constructor(
        private readonly enqueue: (part: LanguageModelV4StreamPart) => void,
        private readonly turn: { variant: string; plan: PromptPlan; ctx: NativeAgentTurnContext | undefined },
    ) {
        this.w = new PartWriter(enqueue, CURSOR_PROVIDER);
        this.sessionId = turn.plan.resumeId;
    }

    read(ev: Record<string, unknown>): void {
        const subtype = ev.subtype as string | undefined;
        switch (ev.type) {
            case "system":
                if (subtype === "init") this.onInit(String(ev.session_id));
                break;
            case "thinking":
                if (subtype === "delta") this.w.reasoning(String(ev.text ?? ""));
                else if (subtype === "completed") this.w.endReasoning();
                this.producedOutput = true;
                break;
            case "assistant":
                this.onAssistant(ev);
                break;
            case "tool_call":
                this.onToolCall(ev, subtype);
                break;
            case "result":
                this.onResult(ev, subtype);
                break;
            default:
                break;
        }
    }

    endAll(): void {
        this.w.endAll();
    }

    private onInit(sessionId: string): void {
        this.sessionId = sessionId;
        linkNativeSession(CURSOR_PROVIDER, this.turn.ctx, sessionId, this.turn.plan.seen);
        this.enqueue({ type: "response-metadata", id: sessionId, modelId: this.turn.variant });
    }

    private onAssistant(ev: Record<string, unknown>): void {
        // Deltas carry a timestamp; the consolidated copy of each
        // segment (model_call_id, or no timestamp) closes it instead.
        const text = ((ev.message as { content?: Array<{ text?: string }> })?.content ?? []).map((c) => c.text ?? "").join("");
        if (ev.model_call_id !== undefined || ev.timestamp_ms === undefined) this.w.endText();
        else this.w.text(text);
        this.producedOutput = true;
    }

    private onToolCall(ev: Record<string, unknown>, subtype: string | undefined): void {
        const id = String(ev.call_id ?? "").replace(/\s+/g, "_");
        const { kind, body } = toolKindOf((ev.tool_call ?? {}) as Record<string, unknown>);
        const mapped = mapCursorTool(kind, cleanArgs(body.args));
        if (subtype === "started") {
            this.toolNames.set(id, mapped.name);
            this.w.toolCall(id, mapped.name, mapped.input);
        } else if (subtype === "completed") {
            if (!this.toolNames.has(id)) this.w.toolCall(id, mapped.name, mapped.input);
            const { value, isError } = toolResultOf(kind, body);
            this.w.toolResult(id, this.toolNames.get(id) ?? mapped.name, value, isError);
        }
        this.producedOutput = true;
    }

    private onResult(ev: Record<string, unknown>, subtype: string | undefined): void {
        this.w.endAll();
        const isError = ev.is_error === true || subtype !== "success";
        if (isError) this.enqueue({ type: "error", error: new Error(`Cursor: ${String(ev.result ?? ev.error ?? subtype)}`) });
        const u = (ev.usage ?? {}) as Record<string, number>;
        const cacheRead = u.cacheReadTokens ?? 0;
        const cacheWrite = u.cacheWriteTokens ?? 0;
        this.enqueue({
            type: "finish",
            usage: makeUsage({
                input: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite),
                cacheRead,
                cacheWrite,
                output: u.outputTokens,
            }),
            finishReason: finishReason(isError ? "error" : "stop", subtype),
            providerMetadata: {
                [CURSOR_PROVIDER]: { sessionId: this.sessionId ?? null, model: this.turn.variant, requestId: (ev.request_id as string) ?? null },
            },
        });
        this.finished = true;
    }
}

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

