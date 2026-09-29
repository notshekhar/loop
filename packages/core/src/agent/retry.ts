/**
 * When a broken stream is worth picking back up.
 *
 * The AI SDK retries the *request* that opens a stream (maxRetries, default 2).
 * Nothing retried a stream that died once it was already running — so a 529 or
 * a dropped socket at step 18 of 20 ended the turn, even though every finished
 * step was already persisted and billed. The turn loop uses this module to
 * decide whether to open a fresh stream over the same conversation and carry
 * on; see the resume block in turn.ts for the conditions on top of these.
 *
 * The classification deliberately mirrors the SDK's own: an APICallError knows
 * whether it is retryable, and second-guessing it is how a 400 ends up being
 * retried three times. What this adds is the layer underneath — a socket that
 * dies mid-body never becomes an APICallError at all.
 */
import { APICallError } from "ai";

/** How many times one turn may reopen its stream before giving up. */
export const DEFAULT_MAX_STREAM_RESUMES = 2;

/** First backoff step; each resume doubles it. */
export const RESUME_BASE_DELAY_MS = 1_000;

/** Ceiling for one backoff wait — past this, waiting is worse than reporting. */
export const RESUME_MAX_DELAY_MS = 15_000;

/**
 * Transport-level failures, which arrive as a plain Error (often wrapped in a
 * `cause` chain) rather than an APICallError. These are the ones that kill a
 * stream mid-body, which is exactly the case the SDK's request retry misses.
 */
const RETRYABLE_NETWORK =
    /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENETDOWN|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_(?:SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT)|socket hang up|fetch failed|network error|premature close|terminated|other side closed)\b/i;

/**
 * Provider error names that mean "busy, try again". Some providers deliver
 * these as a stream `error` part carrying a string or a bare object, with no
 * status code and no APICallError to inspect.
 */
// "try again LATER" only: a bare "try again" also appears in permanent errors
// ("reduce the length of the messages and try again"), which must not resume.
const RETRYABLE_MESSAGE =
    /\b(overloaded(?:_error)?|rate.?limit(?:_error|ed)?|service unavailable|temporarily unavailable|try again later)\b/i;

/** Statuses worth another attempt: rate limiting and transient server faults. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** Walk an error's `cause` chain — undici nests the real reason one or two deep. */
function* chain(err: unknown, depth = 0): Generator<unknown> {
    if (err === null || err === undefined || depth > 5) return;
    yield err;
    if (typeof err === "object" && "cause" in err) yield* chain((err as { cause?: unknown }).cause, depth + 1);
}

/** The text a classifier can read off any error shape. */
function textOf(err: unknown): string {
    if (typeof err === "string") return err;
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    if (err && typeof err === "object") {
        const o = err as { message?: unknown; error?: unknown; code?: unknown; type?: unknown };
        // A stream error part is often `{ error: { type: "overloaded_error" } }`.
        return [o.message, o.type, o.code, typeof o.error === "object" ? textOf(o.error) : o.error]
            .filter((v) => typeof v === "string" || typeof v === "number")
            .join(" ");
    }
    return "";
}

/**
 * Should the turn reopen its stream after this error?
 *
 * Conservative by construction: an unrecognised error is NOT retryable, so a
 * bad request, a bad key, or an over-long context fails once and says so
 * instead of being tried three times at full price.
 */
export function isRetryableStreamError(err: unknown): boolean {
    for (const link of chain(err)) {
        if (APICallError.isInstance(link)) {
            // The SDK's own verdict wins in BOTH directions: a provider that
            // says "don't retry this" on a 5xx knows something the status code
            // doesn't. The status table is only the fallback for an error that
            // carries no verdict at all.
            if (typeof link.isRetryable === "boolean") return link.isRetryable;
            if (link.statusCode !== undefined) return RETRYABLE_STATUS.has(link.statusCode);
        }
        const status = (link as { status?: unknown; statusCode?: unknown })?.status;
        const statusCode = (link as { statusCode?: unknown })?.statusCode;
        for (const s of [status, statusCode]) if (typeof s === "number" && RETRYABLE_STATUS.has(s)) return true;

        const text = textOf(link);
        if (RETRYABLE_NETWORK.test(text)) return true;
        if (RETRYABLE_MESSAGE.test(text)) return true;
    }
    return false;
}

/**
 * Backoff before resume `attempt` (0-based), with full jitter.
 *
 * Jitter matters more than the curve here: a provider-wide overload means
 * every client saw the same 529 at the same moment, and a fixed backoff walks
 * them all back in step.
 */
export function resumeDelayMs(attempt: number, random: () => number = Math.random): number {
    const ceiling = Math.min(RESUME_BASE_DELAY_MS * 2 ** attempt, RESUME_MAX_DELAY_MS);
    // Full jitter: uniform in [ceiling/2, ceiling] — still backs off, without
    // synchronising the retry storm.
    return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Wait, but stay interruptible. A 15s backoff that ignores the abort signal
 * makes Ctrl+C feel broken for as long as it runs.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}

/** A short, one-line reason for the UI, so a retry is never silent. */
export function describeRetry(err: unknown): string {
    const text = textOf(err).trim().replace(/\s+/g, " ");
    if (!text) return "stream failed";
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/**
 * Provider wording for "this request is bigger than I take" — a context-window
 * overflow or a body-size limit. The two are one problem for a caller that can
 * shrink its request, and gateways blur them anyway (a 413 from a proxy, a 400
 * whose body names the context length).
 */
const CONTEXT_OVERFLOW_MESSAGE =
    /context.?(length|window)|maximum context|too many (input )?tokens|prompt is too long|input is too long|request entity too large|payload too large|body (is )?too (large|big)|request too large|reduce the length/i;

/** Did the provider refuse this request for its size? */
export function isContextOverflowError(err: unknown): boolean {
    for (const link of chain(err)) {
        const status = (link as { statusCode?: unknown; status?: unknown }) ?? {};
        if (status.statusCode === 413 || status.status === 413) return true;
        const body = APICallError.isInstance(link) ? (link.responseBody ?? "") : "";
        if (CONTEXT_OVERFLOW_MESSAGE.test(`${textOf(link)} ${body}`)) return true;
    }
    return false;
}
