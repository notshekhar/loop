/**
 * Builds a loop transcript from another agent's chat, one event at a time.
 *
 * Every source (Claude Code, Codex, Cursor) reads its own format and feeds the
 * same five events here — a prompt, text, reasoning, a tool call, a tool
 * result — so the rules that make the result a VALID loop session live in one
 * place:
 *
 * - an assistant message ends where its tool calls are answered, and the
 *   answers follow it as one `tool` message, which is the shape replay draws
 *   and the shape a provider accepts when the conversation is continued;
 * - every call gets exactly one result. A source that lost one (an
 *   interrupted turn) gets a placeholder, because a provider rejects a
 *   history with an unanswered call; a result for a call never seen is
 *   dropped for the same reason.
 */
import type { Entry } from "../../../types";

/** The cap on one imported tool result — loop's own tools cap their output the same way. */
const MAX_RESULT_CHARS = 50_000;

type AssistantPart =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

interface ToolResultPart {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text" | "error-text"; value: string };
}

/** A call that has not been answered yet. */
interface OpenCall {
    toolCallId: string;
    toolName: string;
}

export class TranscriptBuilder {
    private readonly entries: Entry[] = [];
    private assistant: AssistantPart[] = [];
    private results: ToolResultPart[] = [];
    private open: OpenCall[] = [];
    private lastTs = 0;

    user(text: string, ts?: number): void {
        const trimmed = text.trim();
        if (!trimmed) return;
        this.closeTurnStep();
        this.entries.push({ type: "message", role: "user", content: trimmed, ts: this.stamp(ts) });
    }

    text(text: string, ts?: number): void {
        if (!text.trim()) return;
        this.beforeAssistantPart(ts);
        const last = this.assistant.at(-1);
        // Streamed sources split one answer across many records; one block reads as one answer.
        if (last?.type === "text") last.text += text;
        else this.assistant.push({ type: "text", text });
    }

    reasoning(text: string, ts?: number): void {
        if (!text.trim()) return;
        this.beforeAssistantPart(ts);
        this.assistant.push({ type: "reasoning", text });
    }

    toolCall(toolCallId: string, toolName: string, input: unknown, ts?: number): void {
        this.beforeAssistantPart(ts);
        this.assistant.push({ type: "tool-call", toolCallId, toolName, input: input ?? {} });
        this.open.push({ toolCallId, toolName });
    }

    toolResult(toolCallId: string, output: string, isError: boolean, ts?: number): void {
        const at = this.open.findIndex((c) => c.toolCallId === toolCallId);
        if (at < 0) return;
        const [call] = this.open.splice(at, 1);
        this.flushAssistant(ts);
        this.results.push(resultPart(call, output, isError));
    }

    /** The finished transcript. */
    build(): Entry[] {
        this.closeTurnStep();
        return this.entries;
    }

    /** New assistant content after results means a new step: the answered calls go first. */
    private beforeAssistantPart(ts?: number): void {
        if (this.results.length > 0) this.closeTurnStep();
        if (ts !== undefined) this.lastTs = Math.max(this.lastTs, ts);
    }

    /** End the current step: its assistant message, then every result — placeholders for the lost ones. */
    private closeTurnStep(): void {
        this.flushAssistant();
        for (const call of this.open) {
            this.results.push(resultPart(call, "(no result was recorded for this call)", true));
        }
        this.open = [];
        if (this.results.length === 0) return;
        this.entries.push({ type: "message", role: "tool", content: this.results, ts: this.stamp() });
        this.results = [];
    }

    private flushAssistant(ts?: number): void {
        if (this.assistant.length === 0) return;
        this.entries.push({ type: "message", role: "assistant", content: this.assistant, ts: this.stamp(ts) });
        this.assistant = [];
    }

    /** Timestamps never go backwards, so replay's timestamps read in order even where a source omits them. */
    private stamp(ts?: number): number {
        this.lastTs = Math.max(this.lastTs, ts ?? this.lastTs);
        return this.lastTs || Date.now();
    }
}

function resultPart(call: OpenCall, output: string, isError: boolean): ToolResultPart {
    const value =
        output.length > MAX_RESULT_CHARS
            ? `${output.slice(0, MAX_RESULT_CHARS)}\n… (${output.length - MAX_RESULT_CHARS} more characters not imported)`
            : output;
    return {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: isError ? "error-text" : "text", value },
    };
}

/** Parse an ISO timestamp (or epoch ms) a source recorded; undefined when it is missing or junk. */
export function parseTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string" || !value) return undefined;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
}
