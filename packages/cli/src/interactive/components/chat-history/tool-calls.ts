import { formatSubagentActivity, type SubagentActivityPart } from "@notshekhar/loop-core";
import type { ToolExecutionComponent } from "../../ui/tool-execution";

/** Tool calls still waiting for their result, by call id. */
export class PendingToolCalls {
    private pending = new Map<string, ToolExecutionComponent>();

    track(toolCallId: string, comp: ToolExecutionComponent): void {
        this.pending.set(toolCallId, comp);
    }

    /**
     * The box may already exist from a `tool-input-start` stub — fill in the
     * args on it (once they've finished streaming) instead of duplicating it.
     * Returns whether there was such a box.
     */
    fillArgs(toolCallId: string, args: Record<string, unknown>): boolean {
        const existing = this.pending.get(toolCallId);
        if (!existing) return false;
        if (Object.keys(args).length > 0) existing.updateArgs(args);
        return true;
    }

    setStatus(toolCallId: string, status: string): void {
        this.pending.get(toolCallId)?.updateStatus(status);
    }

    updateInputStream(toolCallId: string, fields: Record<string, string>): void {
        this.pending.get(toolCallId)?.updateStreamingInput(fields);
    }

    updateProgress(toolCallId: string, text: string): void {
        this.pending.get(toolCallId)?.updateResult({ content: [{ type: "text", text }], isError: false }, true);
    }

    complete(toolCallId: string, output: unknown, isError: boolean): void {
        const comp = this.pending.get(toolCallId);
        if (!comp) return;
        // Task output carries a run summary — surfaces steps/duration/cost in
        // the done title (live runs and replayed sessions alike).
        const stats = (output as { stats?: { steps?: number; durationMs?: number; usd?: number } } | null)?.stats;
        if (stats && typeof stats === "object") comp.setTaskStats(stats);
        const text = stringifyResult(output);
        comp.updateResult({ content: [{ type: "text", text }], isError }, false);
        this.pending.delete(toolCallId);
    }

    /** Freeze every pending call as "interrupted" and stop tracking it. */
    interruptAll(): void {
        for (const comp of this.pending.values()) comp.markInterrupted();
        this.pending.clear();
    }

    clear(): void {
        this.pending.clear();
    }
}

export function stringifyResult(output: unknown): string {
    if (output == null) return "";
    if (typeof output === "string") return output;
    const o = output as Record<string, unknown>;
    // AI-SDK tool-result output shape { type, value } — used by replayed
    // (persisted) tool results. Unwrap to the underlying text/JSON.
    if (typeof o.type === "string" && "value" in o) {
        const v = o.value;
        if (o.type === "text" || o.type === "error-text") return typeof v === "string" ? v : String(v ?? "");
        if (o.type === "json" || o.type === "error-json") return JSON.stringify(v, null, 2);
        if (o.type === "content" && Array.isArray(v)) {
            return v
                .map((part) => (part?.type === "text" ? part.text : ""))
                .filter(Boolean)
                .join("\n");
        }
    }
    // Task (subagent) output: structured run log; flatten for display. The
    // last text part is the final report, so nothing is appended twice.
    if (Array.isArray(o.history)) {
        return (
            formatSubagentActivity(o.history as SubagentActivityPart[]) ||
            (typeof o.report === "string" ? o.report : "")
        );
    }
    if (typeof o.stdout === "string" || typeof o.stderr === "string") {
        return `${o.stdout ?? ""}${o.stderr ? `\n[stderr]\n${o.stderr}` : ""}`.trim();
    }
    if (typeof o.content === "string") return o.content;
    // Raw MCP CallToolResult shape — the LIVE tool-result event carries this
    // ({ content: [{type:"text", text}], structuredContent?, isError? }), while
    // the persisted entry carries the toModelOutput shape ({type:"content",
    // value}). Unwrap the text blocks the same way so runtime and resume render
    // identically instead of the live view dumping a raw JSON blob. Fall back to
    // structuredContent if the server sent no text content.
    if (Array.isArray(o.content)) {
        const text = (o.content as Array<{ type?: string; text?: string }>)
            .filter((p) => p?.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
        if (text) return text;
        if (o.structuredContent != null) return JSON.stringify(o.structuredContent, null, 2);
    }
    if (typeof o.matches === "string") return o.matches;
    if (Array.isArray((o as { paths?: unknown }).paths)) return (o as { paths: string[] }).paths.join("\n");
    if (Array.isArray((o as { entries?: unknown }).entries)) {
        return (o as { entries: { name: string; type: string }[] }).entries
            .map((e) => (e.type === "dir" ? `${e.name}/` : e.name))
            .join("\n");
    }
    return JSON.stringify(output, null, 2);
}
