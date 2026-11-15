import type { UsageBlock } from "../../types";

export interface PersistedTurnMessage {
    role: "assistant" | "tool";
    content: unknown;
    usage?: UsageBlock;
}

/**
 * Turn one completed step's messages into session entries — assistant text +
 * tool calls, and the tool results — in canonical AI-SDK shape (so they replay
 * and feed straight back to the model). mirrors the reference: one entry per message,
 * persisted as the step finishes (abort-safe — completed steps survive).
 *
 * Task (subagent) tool calls/results are filtered out: they persist separately
 * as `subagent` entries (with their activity log), and keeping them here too
 * would double them on resume and in the model context.
 *
 * Per-step usage rides the step's assistant message: resume seeding sums
 * assistant usages (= turn total) and reads the last for context size.
 */
export function stepMessagesToEntries(
    messages: ReadonlyArray<{ role: string; content: unknown }>,
    stepUsage: UsageBlock | undefined,
): PersistedTurnMessage[] {
    // The ONLY thing held back is the `task` (subagent) call/result — and not
    // to drop data: the subagent is persisted MORE completely as its own
    // `subagent` entry (prompt + full internal activity log + report), so
    // letting it through here too would duplicate the box on resume. Every
    // other part — text, reasoning, tool calls, tool results — is persisted
    // exactly as it streamed.
    const taskCallIds = new Set<string>();
    const out: PersistedTurnMessage[] = [];
    // Resume-time cost seeding sums every usage-bearing assistant entry, so a
    // step's usage must ride exactly ONE of its messages — stamping each would
    // double-bill the step if the SDK ever emits two assistant messages per step.
    let usageToStamp = stepUsage;
    for (const m of messages) {
        if (m.role === "assistant") {
            const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
            const kept = parts.filter((p: { type?: string; toolName?: string; toolCallId?: string }) => {
                if (p?.type === "tool-call" && p.toolName === "task") {
                    if (p.toolCallId) taskCallIds.add(p.toolCallId);
                    return false;
                }
                return true;
            });
            if (kept.length > 0) {
                out.push({ role: "assistant", content: kept, usage: usageToStamp });
                usageToStamp = undefined;
            }
        } else if (m.role === "tool") {
            const parts = Array.isArray(m.content) ? m.content : [];
            const kept = parts.filter(
                (p: { toolCallId?: string }) => !(p?.toolCallId && taskCallIds.has(p.toolCallId)),
            );
            if (kept.length > 0) out.push({ role: "tool", content: kept });
        }
    }
    // A step whose assistant message was ONLY the task tool-call filters to
    // nothing — but its usage is still real billed tokens. Carry it on an
    // empty assistant entry: toModelMessages drops empty content, so it never
    // reaches the model, while resume cost seeding and /steak still count it.
    if (usageToStamp) out.push({ role: "assistant", content: [], usage: usageToStamp });
    return out;
}
