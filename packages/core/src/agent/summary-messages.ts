/**
 * The conversation a compaction summarizes, as real messages.
 *
 * The summarizer used to read the span as one block of serialized text
 * (`[User]: …`, `[Assistant tool calls]: …`). Sending the messages themselves
 * instead keeps what text flattened away — which tool call a result answers,
 * who said what, where a turn ends — and lets the model read the span the way
 * it reads every turn. The instructions follow the span as one last user
 * message, so the model summarizes rather than continues.
 *
 * Three things are still trimmed, as the text form trimmed them: reasoning is
 * dropped (providers return signed blobs larger than what they summarize),
 * tool results keep their first 2,000 characters, and media is named rather
 * than sent.
 */
import type { ModelMessage } from "ai";
import { clipMiddle, TOOL_RESULT_MAX_CHARS, toolOutputText, truncateForSummary } from "./summarize";

type SpanMessage = { role: string; content: unknown };
type Part = Record<string, unknown>;

function mediaNote(part: Part): Part {
    return { type: "text", text: `[${String(part.type ?? "media")}]` };
}

function userMessage(content: unknown): ModelMessage | undefined {
    if (typeof content === "string") return content.trim() ? { role: "user", content } : undefined;
    if (!Array.isArray(content)) return undefined;
    const parts = (content as Part[])
        .map((p) => (p.type === "text" ? p : p.type === "image" || p.type === "file" ? mediaNote(p) : undefined))
        .filter((p): p is Part => p !== undefined && (p.type !== "text" || Boolean(p.text)));
    return parts.length ? ({ role: "user", content: parts } as unknown as ModelMessage) : undefined;
}

function assistantMessage(content: unknown): ModelMessage | undefined {
    if (typeof content === "string") return content.trim() ? { role: "assistant", content } : undefined;
    if (!Array.isArray(content)) return undefined;
    const parts = (content as Part[]).filter((p) => (p.type === "text" && Boolean(p.text)) || p.type === "tool-call");
    return parts.length ? ({ role: "assistant", content: parts } as unknown as ModelMessage) : undefined;
}

function toolMessage(content: unknown): ModelMessage | undefined {
    if (!Array.isArray(content)) return undefined;
    const parts = (content as Part[])
        .filter((p) => p.type === "tool-result")
        .map((p) => {
            const output = p.output as { type?: string } | undefined;
            const type = output?.type === "error-text" || output?.type === "error-json" ? "error-text" : "text";
            return {
                type: "tool-result",
                toolCallId: p.toolCallId,
                toolName: p.toolName,
                output: { type, value: truncateForSummary(toolOutputText(p.output), TOOL_RESULT_MAX_CHARS) },
            };
        });
    return parts.length ? ({ role: "tool", content: parts } as unknown as ModelMessage) : undefined;
}

/** One stored message as the summarizer is sent it, or undefined when nothing is left. */
export function toSummaryMessage(message: SpanMessage): ModelMessage | undefined {
    switch (message.role) {
        case "user":
            return userMessage(message.content);
        case "assistant":
            return assistantMessage(message.content);
        case "tool":
            return toolMessage(message.content);
        default:
            return undefined;
    }
}

/** The span as summarizer messages. */
export function toSummaryMessages(span: ReadonlyArray<SpanMessage>): ModelMessage[] {
    return span.map(toSummaryMessage).filter((m): m is ModelMessage => m !== undefined);
}

/** A message's weight on the summary budget, in characters. */
export function messageChars(message: ModelMessage): number {
    return JSON.stringify(message.content).length;
}

/**
 * Greedy packing of messages into chunks of at most `budget` characters,
 * never separating a tool call from its results: a chunk only ever starts on
 * a user or assistant message. A single group bigger than a whole chunk has
 * its text clipped to fit.
 */
export function chunkMessages(messages: ModelMessage[], budget: number): ModelMessage[][] {
    const groups: ModelMessage[][] = [];
    for (const m of messages) {
        if (m.role === "tool" && groups.length > 0) groups[groups.length - 1].push(m);
        else groups.push([m]);
    }
    const chunks: ModelMessage[][] = [];
    let current: ModelMessage[] = [];
    let size = 0;
    for (const raw of groups) {
        const group = fitGroup(raw, budget);
        const groupSize = group.reduce((sum, m) => sum + messageChars(m), 0);
        if (current.length > 0 && size + groupSize > budget) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(...group);
        size += groupSize;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

/** A group over budget, with every text clipped from the middle so it fits. */
function fitGroup(group: ModelMessage[], budget: number): ModelMessage[] {
    const total = group.reduce((sum, m) => sum + messageChars(m), 0);
    if (total <= budget) return group;
    const share = Math.max(200, Math.floor(budget / (2 * Math.max(1, countTexts(group)))));
    return group.map((m) => clipMessage(m, share));
}

function countTexts(group: ModelMessage[]): number {
    return group.reduce((n, m) => n + (typeof m.content === "string" ? 1 : (m.content as Part[]).length), 0);
}

function clipMessage(message: ModelMessage, max: number): ModelMessage {
    const clip = (text: string) => clipMiddle(text, Math.floor(max / 2), Math.floor(max / 2));
    if (typeof message.content === "string")
        return { ...message, content: clip(message.content) } as unknown as ModelMessage;
    const content = (message.content as Part[]).map((p) => {
        if (p.type === "text" && typeof p.text === "string") return { ...p, text: clip(p.text) };
        const output = p.output as { type?: string; value?: unknown } | undefined;
        if (p.type === "tool-result" && typeof output?.value === "string") {
            return { ...p, output: { ...output, value: clip(output.value) } };
        }
        return p;
    });
    return { ...message, content } as unknown as ModelMessage;
}
