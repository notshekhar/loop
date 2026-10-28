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
 *   options, reasoning level and output cap the turn uses, so whatever works
 *   for chatting works for summarizing.
 * - A dropped stream or a transient 5xx/529 is tried again instead of failing
 *   the compaction on the first blip.
 */
import { streamText } from "ai";
import { getCatalog, modelInfoIn } from "../catalog";
import { getModel, parseModelId } from "../providers";
import { getSetting } from "../settings";
import type { UsageBlock } from "../types";
import { isAbortError } from "./abort";
import { sumUsage } from "./cost";
import { buildAgentCallConfig, withOllamaContext } from "./model-call";
import { abortableDelay, isRetryableStreamError, resumeDelayMs } from "./retry";
import type { ThinkingLevel } from "./thinking";

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** Maximum characters for a tool result in serialized summaries (pi's). */
const TOOL_RESULT_MAX_CHARS = 2000;

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

function truncateForSummary(text: string, maxChars: number): string {
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
 * One summarizer request on the session's own model. Throws on a summary that
 * is cut off (`length`) or empty — either would become the session's only
 * memory of what it replaced — and SummaryAbortedError when aborted.
 */
export async function requestSummary(opts: {
    modelId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    /** The session's reasoning level; the setting when omitted. */
    thinkingLevel?: ThinkingLevel;
    /** Called once per finished attempt that reported usage, so every attempt is billed. */
    onUsage?: (usage: UsageBlock) => void;
}): Promise<SummaryResult> {
    const { provider, model: modelShortId } = parseModelId(opts.modelId);
    const modelInfo = modelInfoIn(await getCatalog(), opts.modelId);
    const thinkingLevel = opts.thinkingLevel ?? getSetting("thinkingLevel") ?? "off";
    const call = buildAgentCallConfig({ provider, modelShortId, thinkingLevel, modelInfo });
    const providerOptions = withOllamaContext(call.providerOptions, provider, modelInfo);
    const maxOutputTokens =
        call.maxOutputTokens ??
        (modelInfo?.maxOutput && modelInfo.maxOutput > 0
            ? Math.min(modelInfo.maxOutput, SUMMARY_MAX_OUTPUT_TOKENS)
            : undefined);
    const model = await getModel(opts.modelId);

    let usage: UsageBlock | undefined;
    for (let attempt = 0; ; attempt++) {
        if (opts.abortSignal?.aborted) throw new SummaryAbortedError();
        try {
            const result = streamText({
                model,
                instructions: SUMMARIZATION_SYSTEM_PROMPT,
                prompt: opts.prompt,
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
