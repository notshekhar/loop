/**
 * The API calls an imported chat made, and the tokens each one used — what
 * its cost is estimated from (cost.ts).
 *
 * Claude Code and Codex log real counts per call. Cursor logs none, so its
 * calls are estimated from the transcript itself: each assistant step is one
 * call that re-read the conversation so far (input) and wrote that step
 * (output), at the usual ~4 characters a token.
 */
import type { Entry } from "../../../types";

export interface CallTokens {
    /** Input not served from a cache. */
    input: number;
    cacheRead: number;
    cacheWrite: number;
    /** Includes reasoning. */
    output: number;
    reasoning?: number;
}

export interface ImportedCall {
    ts: number;
    /** The model as the agent named it; undefined when the source doesn't say. */
    model?: string;
    tokens: CallTokens;
    /** Counted from text, not read from the source's own records. */
    estimated: boolean;
}

/** The usual rule of thumb for English and code. */
const CHARS_PER_TOKEN = 4;

// ---- Claude Code ---------------------------------------------------------------

interface ClaudeUsageRecord {
    type?: string;
    timestamp?: string;
    message?: {
        id?: string;
        model?: string;
        usage?: {
            input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
            output_tokens?: number;
        };
    };
}

/**
 * One call per API message. Claude Code writes a message as one record per
 * content block, each carrying the same usage, so a message counts once.
 * Every message counts — a rewound branch was still paid for — except the
 * CLI's own `<synthetic>` placeholders, which never reached the API.
 */
export function claudeCalls(records: readonly unknown[]): ImportedCall[] {
    const byMessage = new Map<string, ImportedCall>();
    for (const record of records as ClaudeUsageRecord[]) {
        const m = record.message;
        if (record.type !== "assistant" || !m?.id || !m.usage || m.model === "<synthetic>") continue;
        byMessage.set(m.id, {
            ts: timestampOf(record.timestamp),
            model: m.model,
            tokens: {
                input: m.usage.input_tokens ?? 0,
                cacheRead: m.usage.cache_read_input_tokens ?? 0,
                cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
                output: m.usage.output_tokens ?? 0,
            },
            estimated: false,
        });
    }
    return [...byMessage.values()];
}

// ---- Codex -----------------------------------------------------------------------

interface CodexTotals {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
}

interface CodexUsageRecord {
    type?: string;
    timestamp?: string;
    payload?: { type?: string; model?: string; info?: { total_token_usage?: CodexTotals } | null };
}

const TOTAL_FIELDS = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
] as const;

/**
 * Codex reports a running total after each call (`token_count` events) and
 * sometimes repeats an event, so a call is the change in the total — a
 * repeat changes nothing and counts nothing. The model is the latest
 * `turn_context`'s.
 */
export function codexCalls(records: readonly unknown[]): ImportedCall[] {
    const calls: ImportedCall[] = [];
    let model: string | undefined;
    let previous: Required<CodexTotals> = {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
    };
    for (const record of records as CodexUsageRecord[]) {
        if (record.type === "turn_context" && record.payload?.model) model = record.payload.model;
        const total =
            record.type === "event_msg" && record.payload?.type === "token_count"
                ? record.payload.info?.total_token_usage
                : undefined;
        if (!total) continue;
        const now = Object.fromEntries(TOTAL_FIELDS.map((f) => [f, total[f] ?? 0])) as Required<CodexTotals>;
        const delta = Object.fromEntries(
            TOTAL_FIELDS.map((f) => [f, Math.max(0, now[f] - previous[f])]),
        ) as Required<CodexTotals>;
        previous = now;
        if (delta.input_tokens === 0 && delta.output_tokens === 0) continue;
        calls.push({
            ts: timestampOf(record.timestamp),
            model,
            tokens: {
                // Codex's input includes the cached share.
                input: Math.max(0, delta.input_tokens - delta.cached_input_tokens - delta.cache_write_input_tokens),
                cacheRead: delta.cached_input_tokens,
                cacheWrite: delta.cache_write_input_tokens,
                output: delta.output_tokens,
                reasoning: delta.reasoning_output_tokens,
            },
            estimated: false,
        });
    }
    return calls;
}

// ---- estimated from the transcript ---------------------------------------------

/** One call per assistant step: it read everything before it, and wrote itself. */
export function estimatedCalls(entries: readonly Entry[]): ImportedCall[] {
    const calls: ImportedCall[] = [];
    let contextChars = 0;
    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const chars = charsOf(entry.content);
        if (entry.role === "assistant") {
            calls.push({
                ts: entry.ts,
                tokens: { input: tokens(contextChars), cacheRead: 0, cacheWrite: 0, output: tokens(chars) },
                estimated: true,
            });
        }
        contextChars += chars;
    }
    return calls;
}

function tokens(chars: number): number {
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

function charsOf(content: unknown): number {
    if (typeof content === "string") return content.length;
    if (!Array.isArray(content)) return 0;
    let n = 0;
    for (const part of content as Array<Record<string, unknown>>) {
        if (typeof part.text === "string") n += part.text.length;
        if (part.input !== undefined) n += JSON.stringify(part.input).length;
        const output = part.output as { value?: unknown } | undefined;
        if (typeof output?.value === "string") n += output.value.length;
    }
    return n;
}

function timestampOf(value: string | undefined): number {
    const ms = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(ms) ? Date.now() : ms;
}
