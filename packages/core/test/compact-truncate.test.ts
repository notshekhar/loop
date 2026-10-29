/**
 * When every summary attempt fails, a compaction truncates instead: the span
 * a summary would have replaced is dropped and a mechanical record of it
 * (the user's own words, files, commands) takes its place. A session too big
 * to summarize still gets smaller instead of failing at every turn.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Session } from "../src/sessions";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// Delegating mock (see stream-resume.test.ts): bun module mocks leak across
// files, so getModel is only faked while a test has set currentModel.
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
        currentModel ?? realProviders.getModel(...args),
}));

const MODEL = "xai/grok-build-0.1";

afterEach(() => {
    currentModel = null;
});

/** A model whose every request is refused. */
function refusing(statusCode = 401) {
    let calls = 0;
    currentModel = new MockLanguageModelV3({
        doStream: async () => {
            calls++;
            throw new APICallError({
                message: `HTTP ${statusCode}`,
                url: "https://example.test",
                requestBodyValues: {},
                statusCode,
                isRetryable: false,
            });
        },
    });
    return () => calls;
}

function mk(): Session {
    const dir = mkdtempSync(join(tmpdir(), "loop-compact-truncate-"));
    return new Session(
        { id: `s-${Math.random().toString(36).slice(2)}`, createdAt: 0, cwd: dir, provider: "xai", model: MODEL },
        join(dir, "s.jsonl"),
        [],
    );
}

const msg = (role: "user" | "assistant", content: unknown): Entry =>
    ({ type: "message", role, content, ts: 0 }) as Entry;

/** ~6k-token requests, each editing a file, so a 20k kept window cuts on a user message. */
async function chat(s: Session, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await s.append(msg("user", `request ${i} ${"x".repeat(24_000)}`));
        await s.append(
            msg("assistant", [
                { type: "text", text: `answer ${i}` },
                { type: "tool-call", toolCallId: `c${i}`, toolName: "edit", input: { path: `src/f${i}.ts` } },
            ]),
        );
        await s.append({
            type: "message",
            role: "tool",
            content: [
                { type: "tool-result", toolCallId: `c${i}`, toolName: "edit", output: { type: "text", value: "ok" } },
            ],
            ts: 0,
        } as Entry);
        await s.append(msg("assistant", `done ${i}`));
    }
}

describe("a compaction whose summary fails", () => {
    test("truncates instead: the span is cut and a record of it replaces the summary", async () => {
        refusing();
        const { runCompact, compactedContextEntries, TRUNCATION_PREAMBLE } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 8);
        const result = await runCompact({ session: s, modelId: MODEL });

        expect(result.truncated).toContain("HTTP 401");
        expect(result.cutAt).toBeGreaterThan(0);
        expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
        expect(result.summary).toStartWith(TRUNCATION_PREAMBLE);
        // The user's own words and the files touched survive the cut.
        expect(result.summary).toContain("request 0");
        expect(result.summary).toContain("src/f0.ts");
        // A record, not a summary: no model output, and the span is gone.
        const context = compactedContextEntries(s).map((e) => (e.kind === "message" ? String(e.content) : ""));
        expect(context[0]).toContain(TRUNCATION_PREAMBLE);
        expect(context.slice(1).some((c) => c.startsWith("request 0 "))).toBe(false);

        const entry = s.getBranch().findLast((e) => e.type === "compact");
        expect(entry).toMatchObject({ type: "compact", truncated: "HTTP 401", cutAt: result.cutAt });
    });

    test("a later truncation carries the earlier summary whole", async () => {
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 8);
        currentModel = new MockLanguageModelV3({
            doStream: async () => ({
                stream: new ReadableStream({
                    start(c) {
                        for (const p of [
                            { type: "text-start", id: "s" },
                            { type: "text-delta", id: "s", delta: "## Goal\nEARLIER-SUMMARY" },
                            { type: "text-end", id: "s" },
                            {
                                type: "finish",
                                finishReason: { unified: "stop", raw: "stop" },
                                usage: {
                                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                                },
                            },
                        ])
                            c.enqueue(p);
                        c.close();
                    },
                }),
            }),
        });
        await runCompact({ session: s, modelId: MODEL });
        await chat(s, 8);
        refusing();
        const second = await runCompact({ session: s, modelId: MODEL });
        expect(second.truncated).toBeDefined();
        expect(second.summary).toContain("EARLIER-SUMMARY");
    });

    test("an abort is not truncated", async () => {
        refusing();
        const { runCompact, CompactAbortedError } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 8);
        const abort = new AbortController();
        abort.abort();
        await expect(runCompact({ session: s, modelId: MODEL, abortSignal: abort.signal })).rejects.toBeInstanceOf(
            CompactAbortedError,
        );
        expect(s.getBranch().some((e) => e.type === "compact")).toBe(false);
    });

    test("idle compaction reports a failure rather than truncating", async () => {
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 8);
        await expect(
            runCompact({
                session: s,
                modelId: MODEL,
                trigger: "idle",
                summarize: async () => {
                    throw new Error("idle summary failed");
                },
            }),
        ).rejects.toThrow("idle summary failed");
        expect(s.getBranch().some((e) => e.type === "compact")).toBe(false);
    });
});
