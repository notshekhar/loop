/**
 * What counts as worth retrying.
 *
 * The cost of getting this wrong runs both ways: too eager and a bad request
 * is paid for three times, too shy and a 529 at step 18 throws the turn away.
 * The default is "no" — only a recognised transient failure resumes.
 */
import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import {
    abortableDelay,
    describeRetry,
    isContextOverflowError,
    isRetryableStreamError,
    RESUME_MAX_DELAY_MS,
    resumeDelayMs,
} from "../src/agent/retry";

const apiError = (statusCode: number, opts: { isRetryable?: boolean; message?: string } = {}) =>
    new APICallError({
        message: opts.message ?? `HTTP ${statusCode}`,
        url: "https://api.example.com/v1/messages",
        requestBodyValues: {},
        statusCode,
        ...(opts.isRetryable !== undefined ? { isRetryable: opts.isRetryable } : {}),
    });

describe("transient failures resume", () => {
    test("the SDK's own verdict is honoured", () => {
        expect(isRetryableStreamError(apiError(529, { isRetryable: true }))).toBe(true);
    });

    test("overload and rate-limit statuses", () => {
        for (const status of [408, 429, 500, 502, 503, 504, 529]) {
            expect({ status, retry: isRetryableStreamError(apiError(status)) }).toEqual({ status, retry: true });
        }
    });

    test("a socket that dies mid-body, which never becomes an APICallError", () => {
        // This is the case the SDK's request-level retry cannot see: the
        // request succeeded, the stream did not.
        for (const message of [
            "read ECONNRESET",
            "socket hang up",
            "fetch failed",
            "terminated",
            "other side closed",
            "UND_ERR_SOCKET",
        ]) {
            expect({ message, retry: isRetryableStreamError(new Error(message)) }).toEqual({ message, retry: true });
        }
    });

    test("a reason buried in a cause chain still counts", () => {
        // undici nests the real failure a level or two down.
        const err = new Error("fetch failed", { cause: new Error("read ECONNRESET") });
        expect(isRetryableStreamError(err)).toBe(true);
    });

    test("a provider's error part, which may be a bare object or a string", () => {
        expect(isRetryableStreamError({ error: { type: "overloaded_error" } })).toBe(true);
        expect(isRetryableStreamError("overloaded_error")).toBe(true);
        expect(isRetryableStreamError({ type: "rate_limit_error" })).toBe(true);
    });
});

describe("permanent failures do not", () => {
    test("client errors are the caller's fault and will fail again", () => {
        for (const status of [400, 401, 403, 404, 413, 422]) {
            expect({ status, retry: isRetryableStreamError(apiError(status)) }).toEqual({ status, retry: false });
        }
    });

    test("an explicit isRetryable:false is respected even on a 5xx", () => {
        expect(isRetryableStreamError(apiError(500, { isRetryable: false }))).toBe(false);
    });

    test("a context-length error is not transient", () => {
        const err = apiError(400, { message: "prompt is too long: 250000 tokens > 200000 maximum" });
        expect(isRetryableStreamError(err)).toBe(false);
    });

    test('a permanent error that happens to say "try again" is not retried', () => {
        // "reduce the length of the messages and try again" is a context-length
        // failure; retrying it burns the same tokens for the same refusal.
        const err = new Error("This model's maximum context length is 200000 tokens. Reduce it and try again.");
        expect(isRetryableStreamError(err)).toBe(false);
        // Whereas "try again later" really does mean later.
        expect(isRetryableStreamError(new Error("Server busy, please try again later"))).toBe(true);
    });

    test("an unrecognised error defaults to no", () => {
        expect(isRetryableStreamError(new Error("something odd happened"))).toBe(false);
        expect(isRetryableStreamError(undefined)).toBe(false);
        expect(isRetryableStreamError(null)).toBe(false);
        expect(isRetryableStreamError({})).toBe(false);
    });

    test("a cycle in the cause chain terminates", () => {
        const a = new Error("a") as Error & { cause?: unknown };
        const b = new Error("b") as Error & { cause?: unknown };
        a.cause = b;
        b.cause = a;
        expect(isRetryableStreamError(a)).toBe(false);
    });
});

describe("backoff", () => {
    test("doubles, and is capped", () => {
        // random() = 1 gives the top of each jitter window.
        const top = (attempt: number) => resumeDelayMs(attempt, () => 1);
        expect(top(0)).toBe(1000);
        expect(top(1)).toBe(2000);
        expect(top(2)).toBe(4000);
        expect(top(20)).toBe(RESUME_MAX_DELAY_MS);
    });

    test("jitters, so a provider-wide outage doesn't retry in lockstep", () => {
        // Full jitter spreads over the top half of the window.
        expect(resumeDelayMs(1, () => 0)).toBe(1000);
        expect(resumeDelayMs(1, () => 1)).toBe(2000);
        const spread = new Set(Array.from({ length: 50 }, () => resumeDelayMs(2)));
        expect(spread.size).toBeGreaterThan(1);
    });
});

describe("abortableDelay", () => {
    test("resolves early when the signal fires", async () => {
        const ctrl = new AbortController();
        const started = Date.now();
        const waited = abortableDelay(10_000, ctrl.signal);
        ctrl.abort();
        await waited;
        // Ctrl+C must not wait out a 10s backoff.
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    test("resolves immediately when already aborted", async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const started = Date.now();
        await abortableDelay(10_000, ctrl.signal);
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    test("otherwise it actually waits", async () => {
        const started = Date.now();
        await abortableDelay(50);
        expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    });
});

describe("describeRetry", () => {
    test("gives a one-line reason", () => {
        expect(describeRetry(new Error("overloaded_error"))).toBe("Error: overloaded_error");
        expect(describeRetry(undefined)).toBe("stream failed");
    });

    test("collapses newlines and truncates, so the UI gets one line", () => {
        const long = describeRetry(new Error("x".repeat(500)));
        expect(long.length).toBeLessThanOrEqual(120);
        expect(describeRetry("a\n\nb")).toBe("a b");
    });
});

describe("a request refused for its size", () => {
    test("a 413 from a gateway, whatever its wording", () => {
        expect(isContextOverflowError(apiError(413))).toBe(true);
    });

    test("a 400 whose message or body names the context", () => {
        for (const message of [
            "This model's maximum context length is 131072 tokens",
            "prompt is too long: 210000 tokens > 200000 maximum",
            "Request body too large",
            "Please reduce the length of the messages or completion.",
        ]) {
            expect({ message, overflow: isContextOverflowError(new Error(message)) }).toEqual({
                message,
                overflow: true,
            });
        }
        const withBody = new APICallError({
            message: "Bad Request",
            url: "https://example.test",
            requestBodyValues: {},
            statusCode: 400,
            responseBody: '{"error":{"code":"context_length_exceeded"}}',
        });
        expect(isContextOverflowError(withBody)).toBe(true);
    });

    test("other failures are not mistaken for it", () => {
        expect(isContextOverflowError(apiError(401))).toBe(false);
        expect(isContextOverflowError(apiError(529, { isRetryable: true }))).toBe(false);
        expect(isContextOverflowError(new Error("invalid api key"))).toBe(false);
    });
});
