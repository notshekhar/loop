/**
 * The one summarizer request behind /compact, auto-compaction and /tree branch
 * summaries — pi's `completeSummarization` (core/compaction), on the AI SDK.
 *
 * Three things it does that a bare `generateText` did not, each of which was a
 * way for a compaction to fail at exactly the moment it was needed:
 *
 * - It STREAMS. A non-streaming request sends nothing back until the whole
 *   summary is written, which on a big session with reasoning is minutes of a
 *   silent socket — long enough for a proxy, gateway or client to give up on.
 * - It is shaped like the session's own requests: the same model, provider
 *   options and output cap the turn uses, so whatever works for chatting
 *   works for summarizing — but at the model's LOWEST reasoning, because a
 *   summary needs none and thinking over the largest request a session ever
 *   sends is minutes before the first word.
 * - A dropped stream or a transient 5xx/529 is tried again instead of failing
 *   the compaction on the first blip.
 */
import { APICallError, jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from "ai";
import { getCatalog, modelInfoIn } from "../catalog";
import { getModel, parseModelId } from "../providers";
import { getSetting } from "../settings";
import type { UsageBlock } from "../types";
import { isAbortError } from "./abort";
import { sumUsage } from "./cost";
import { buildAgentCallConfig, withOllamaContext } from "./model-call";
import { abortableDelay, isContextOverflowError, isRetryableStreamError, resumeDelayMs } from "./retry";
import { lowestThinkingLevel, type ThinkingLevel } from "./thinking";

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** Maximum characters of one tool result the summarizer is sent (pi's). */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** pi-ai's default output cap: the model's own, but never past 32k. */
const SUMMARY_MAX_OUTPUT_TOKENS = 32_000;

/** Attempts after the first for a transient failure (dropped stream, 529, 5xx). */
const MAX_SUMMARY_RETRIES = 3;

export class SummaryAbortedError extends Error {
    constructor() {
        super("summary aborted");
        this.name = "SummaryAbortedError";
    }
}

/** Keep the head and tail of `text`, naming how much of the middle went. */
export function clipMiddle(text: string, head: number, tail: number): string {
    if (text.length <= head + tail) return text;
    const omitted = text.length - head - tail;
    return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(text.length - tail)}`;
}

export function truncateForSummary(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** A persisted tool result's output as plain text. */
export function toolOutputText(output: unknown): string {
    if (typeof output === "string") return output;
    const o = output as { type?: string; value?: unknown } | undefined;
    if (!o || typeof o !== "object") return "";
    if (o.type === "text" || o.type === "error-text") return String(o.value ?? "");
    if (o.type === "content" && Array.isArray(o.value)) {
        return o.value
            .map((p: { type?: string; text?: string }) =>
                p.type === "text" ? (p.text ?? "") : `[${p.type ?? "media"}]`,
            )
            .join("\n");
    }
    return JSON.stringify(o.value ?? o);
}

type SerializableMessage = { role: string; content: unknown };
type Part = Record<string, unknown>;

/** The text parts of a message's content, joined. */
function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as Part[])
        .filter((p) => p.type === "text")
        .map((p) => String(p.text ?? ""))
        .join("\n");
}

/**
 * One message as the summarizer reads it — pi's `serializeConversation`.
 * Reasoning is dropped (providers return summaries of it, often with signed
 * blobs larger than the context it summarizes), tool results keep their
 * first 2,000 chars, media is named but not sent.
 */
export function serializeMessage(message: SerializableMessage, opts: { toolResults?: boolean } = {}): string {
    const parts: string[] = [];
    if (message.role === "user") {
        const text = textOf(message.content);
        const media = Array.isArray(message.content)
            ? (message.content as Part[])
                  .filter((p) => p.type === "image" || p.type === "file")
                  .map((p) => `[${p.type}]`)
            : [];
        const all = [text, ...media].filter(Boolean).join(" ");
        if (all) parts.push(`[User]: ${all}`);
    } else if (message.role === "assistant") {
        const text = textOf(message.content);
        if (text) parts.push(`[Assistant]: ${text}`);
        const calls = Array.isArray(message.content)
            ? (message.content as Part[])
                  .filter((p) => p.type === "tool-call")
                  .map((p) => {
                      const input = (p.input ?? {}) as Record<string, unknown>;
                      const args =
                          input && typeof input === "object" && !Array.isArray(input)
                              ? Object.entries(input)
                                    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                                    .join(", ")
                              : JSON.stringify(input);
                      return `${String(p.toolName)}(${args})`;
                  })
            : [];
        if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (message.role === "tool" && opts.toolResults !== false) {
        if (!Array.isArray(message.content)) return "";
        for (const p of message.content as Part[]) {
            if (p.type !== "tool-result") continue;
            const text = toolOutputText(p.output);
            if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
        }
    }
    return parts.join("\n\n");
}

export function serializeConversation(
    messages: ReadonlyArray<SerializableMessage>,
    opts: { toolResults?: boolean } = {},
): string {
    return messages
        .map((m) => serializeMessage(m, opts))
        .filter(Boolean)
        .join("\n\n");
}

export interface SummaryResult {
    text: string;
    usage?: UsageBlock;
}

/**
 * One summarizer request on the session's own model, at the least reasoning
 * it takes (lowestThinkingLevel). Throws on a summary that is cut off
 * (`length`) or empty — either would become the session's only memory of
 * what it replaced — and SummaryAbortedError when aborted.
 *
 * A model that refuses the lowest level outright (a 400 for "reasoning
 * effort none") is asked once more at the session's own level: the settings
 * every turn already succeeds with.
 */
export async function requestSummary(opts: {
    modelId: string;
    /** What to summarize, ending in the instructions (a user message). */
    messages: ModelMessage[];
    abortSignal?: AbortSignal;
    /** The session's reasoning level (the setting when omitted) — only the
     * fallback for a model that rejects its lowest level. */
    thinkingLevel?: ThinkingLevel;
    /** Called once per finished attempt that reported usage, so every attempt is billed. */
    onUsage?: (usage: UsageBlock) => void;
}): Promise<SummaryResult> {
    const { model: modelShortId } = parseModelId(opts.modelId);
    const lowest = lowestThinkingLevel(modelShortId);
    const session = opts.thinkingLevel ?? getSetting("thinkingLevel") ?? "off";
    try {
        return await requestSummaryAt(opts, lowest);
    } catch (err) {
        if (session === lowest || !isRejectedRequest(err)) throw err;
        return requestSummaryAt(opts, session);
    }
}

/**
 * The provider turned the request down as malformed — the shape of a model
 * that does not accept a reasoning setting. Not an overflow (that is too big,
 * not wrong) and not anything worth retrying as is.
 */
function isRejectedRequest(err: unknown): boolean {
    if (err instanceof SummaryAbortedError || isContextOverflowError(err) || isRetryableStreamError(err)) return false;
    for (let link: unknown = err, depth = 0; link && depth < 4; depth++) {
        if (APICallError.isInstance(link)) return link.statusCode === 400 || link.statusCode === 422;
        link = (link as { cause?: unknown }).cause;
    }
    return false;
}

async function requestSummaryAt(
    opts: Parameters<typeof requestSummary>[0],
    thinkingLevel: ThinkingLevel,
): Promise<SummaryResult> {
    const { provider, model: modelShortId } = parseModelId(opts.modelId);
    const modelInfo = modelInfoIn(await getCatalog(), opts.modelId);
    const call = buildAgentCallConfig({ provider, modelShortId, thinkingLevel, modelInfo });
    const providerOptions = withOllamaContext(call.providerOptions, provider, modelInfo);
    const maxOutputTokens =
        call.maxOutputTokens ??
        (modelInfo?.maxOutput && modelInfo.maxOutput > 0
            ? Math.min(modelInfo.maxOutput, SUMMARY_MAX_OUTPUT_TOKENS)
            : undefined);
    const model = await getModel(opts.modelId);
    const tools = toolStubs(opts.messages);

    let usage: UsageBlock | undefined;
    for (let attempt = 0; ; attempt++) {
        if (opts.abortSignal?.aborted) throw new SummaryAbortedError();
        try {
            const result = streamText({
                model,
                instructions: SUMMARIZATION_SYSTEM_PROMPT,
                messages: opts.messages,
                // The span's tool calls need their tools declared; none may run.
                ...(tools ? { tools, toolChoice: "none" as const } : {}),
                abortSignal: opts.abortSignal,
                ...(maxOutputTokens ? { maxOutputTokens } : {}),
                ...(call.reasoning ? { reasoning: call.reasoning } : {}),
                ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
                // Errors arrive as stream parts below; the default handler would
                // also print them to the terminal under the TUI.
                onError: () => {},
            });
            let text = "";
            let finishReason: string | undefined;
            for await (const part of result.fullStream) {
                if (part.type === "text-delta") text += part.text;
                else if (part.type === "error") throw part.error;
                else if (part.type === "abort") throw new SummaryAbortedError();
                else if (part.type === "finish") {
                    finishReason = part.finishReason;
                    if (part.totalUsage) {
                        usage = sumUsage(usage, part.totalUsage as UsageBlock);
                        opts.onUsage?.(part.totalUsage as UsageBlock);
                    }
                }
            }
            if (opts.abortSignal?.aborted) throw new SummaryAbortedError();
            if (finishReason === "length") throw new Error("the summary hit the output limit before it finished");
            if (!text.trim()) throw new Error("the model returned an empty summary");
            return { text: text.trim(), ...(usage ? { usage } : {}) };
        } catch (err) {
            if (err instanceof SummaryAbortedError || isAbortError(err) || opts.abortSignal?.aborted) {
                throw new SummaryAbortedError();
            }
            if (attempt >= MAX_SUMMARY_RETRIES || !isRetryableStreamError(err)) throw err;
            await abortableDelay(resumeDelayMs(attempt), opts.abortSignal);
        }
    }
}

/**
 * Declarations for every tool the messages call. A provider refuses a
 * history with tool calls in it and no tools declared (Anthropic: "Requests
 * which include `tool_use` or `tool_result` blocks must define tools"), and
 * the summary request is sent with toolChoice "none", so a bare object
 * schema is all a stub needs.
 */
export function toolStubs(messages: ModelMessage[]): ToolSet | undefined {
    const names = new Set<string>();
    for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content as Part[]) {
            if ((p.type === "tool-call" || p.type === "tool-result") && typeof p.toolName === "string")
                names.add(p.toolName);
        }
    }
    if (names.size === 0) return undefined;
    const stubs: ToolSet = {};
    for (const name of names) {
        stubs[name] = tool({
            description: "",
            inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
        });
    }
    return stubs;
}
