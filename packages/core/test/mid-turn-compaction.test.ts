/**
 * Compaction between the steps of one turn, and a summarizer that survives a
 * session too big to send in one request.
 *
 * Before this, the threshold was checked once, before a turn's first step: a
 * long tool-heavy turn could climb from 30% to past the window with nothing
 * looking. And /compact sent the whole transcript — tool output, reasoning,
 * provider blobs — as one prompt, which a gateway refused as too big at the
 * very moment compaction was needed most.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { clearContextPolicy } from "../src/agent/context-policy";
import { Session } from "../src/sessions";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// Same delegating-mock pattern as stream-resume.test.ts: bun module mocks leak
// across files, so only fake getModel while a test has set currentModel.
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
        currentModel ?? realProviders.getModel(...args),
}));

const MODEL = "xai/grok-build-0.1"; // 256k window in the catalog → 80% line at 204.8k

type Part = Record<string, unknown>;

const usage = (input: number, output = 10) => ({
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
});

function streamOf(parts: Part[]) {
    let i = 0;
    return {
        stream: new ReadableStream({
            async pull(controller) {
                await new Promise((r) => setTimeout(r, 1));
                if (i < parts.length) controller.enqueue(parts[i++]);
                else controller.close();
            },
        }),
    };
}

/** A step that calls `ls` while reporting `inputTokens` of context. */
const toolStep = (id: string, inputTokens: number): Part[] => [
    { type: "tool-call", toolCallId: id, toolName: "ls", input: JSON.stringify({}) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: usage(inputTokens) },
];

const answer = (text: string): Part[] => [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(1_000) },
];

const summaryReply = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(100, 20),
    warnings: [],
});

const msg = (role: "user" | "assistant", content: string): Entry => ({ type: "message", role, content, ts: 0 });

function mkSession(dir: string, history: Entry[] = []) {
    return new Session(
        { id: "t", createdAt: 0, cwd: dir, provider: "xai", model: MODEL },
        join(dir, "s.jsonl"),
        history,
    );
}

async function runTurnWith(session: Session, dir: string) {
    const { runTurn, CostTracker } = await import("../src/agent");
    const em = new EventEmitter();
    const events: Array<{ type: string; payload: unknown }> = [];
    for (const name of ["compact-start", "compact-end", "finish", "error", "stream-retry", "text-delta"]) {
        em.on(name, (payload: unknown) => events.push({ type: name, payload }));
    }
    await runTurn({
        session,
        modelId: MODEL,
        userInput: "keep going",
        cwd: dir,
        tracker: new CostTracker({ persist: false }),
        emitter: em as never,
    });
    return events;
}

/** ~30k tokens of earlier conversation — more than the 20k a compaction keeps. */
const oldHistory = (): Entry[] =>
    Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", `old message ${i} ${"z".repeat(12_000)}`),
    );

// The context policy is process-wide, and relay's tests leave theirs
// registered; these tests are about the core summarizer.
beforeEach(() => {
    clearContextPolicy();
});

afterEach(() => {
    currentModel = null;
});

describe("a turn that crosses the threshold between steps compacts and carries on", () => {
    test("stops at the step boundary, summarizes, and reopens the stream over the summary", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-midturn-"));
        let streams = 0;
        currentModel = new MockLanguageModelV3({
            doStream: async () => (streams++ === 0 ? streamOf(toolStep("c1", 230_000)) : streamOf(answer("done"))),
            doGenerate: async () => summaryReply("SUMMARY OF EARLIER WORK"),
        });
        const session = mkSession(dir, oldHistory());
        const events = await runTurnWith(session, dir);

        const kinds = events.filter((e) => e.type !== "text-delta").map((e) => e.type);
        // One compaction, then exactly one finish — the stop for compaction is
        // not the end of the turn, and it is not a retry.
        expect(kinds).toEqual(["compact-start", "compact-end", "finish"]);
        expect(events.filter((e) => e.type === "text-delta").map((e) => e.payload)).toEqual(["done"]);

        const compact = session.entries().find((e) => e.type === "compact") as { summary: string; cutAt: number };
        expect(compact.summary).toBe("SUMMARY OF EARLIER WORK");
        expect(compact.cutAt).toBeGreaterThan(0);

        // The reopened stream reads the summary, not the history it replaced.
        const resumedPrompt = JSON.stringify(currentModel.doStreamCalls[1].prompt);
        expect(resumedPrompt).toContain("SUMMARY OF EARLIER WORK");
        expect(resumedPrompt).not.toContain("old message 0");
        expect(streams).toBe(2);
    });

    test("under the threshold nothing stops early", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-midturn-"));
        let streams = 0;
        currentModel = new MockLanguageModelV3({
            doStream: async () => (streams++ === 0 ? streamOf(toolStep("c1", 50_000)) : streamOf(answer("done"))),
            doGenerate: async () => summaryReply("unused"),
        });
        const events = await runTurnWith(mkSession(dir, oldHistory()), dir);
        expect(events.some((e) => e.type === "compact-start")).toBe(false);
        expect(currentModel.doGenerateCalls).toHaveLength(0);
        expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
    });

    test("a compaction that frees nothing is not retried after every step", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-midturn-"));
        let streams = 0;
        currentModel = new MockLanguageModelV3({
            // Three over-threshold steps in a session too short to cut.
            doStream: async () => {
                streams++;
                return streams <= 3 ? streamOf(toolStep(`c${streams}`, 230_000)) : streamOf(answer("done"));
            },
            doGenerate: async () => summaryReply("unused"),
        });
        const events = await runTurnWith(mkSession(dir), dir);
        expect(events.filter((e) => e.type === "compact-start")).toHaveLength(1);
        expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
        expect(events.filter((e) => e.type === "text-delta").map((e) => e.payload)).toEqual(["done"]);
    });

    test("a failed summary is reported and the turn still finishes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-midturn-"));
        let streams = 0;
        currentModel = new MockLanguageModelV3({
            doStream: async () => (streams++ === 0 ? streamOf(toolStep("c1", 230_000)) : streamOf(answer("done"))),
            doGenerate: async () => {
                throw new APICallError({
                    message: "invalid api key",
                    url: "https://example.test",
                    requestBodyValues: {},
                    statusCode: 401,
                    isRetryable: false,
                });
            },
        });
        const events = await runTurnWith(mkSession(dir, oldHistory()), dir);
        const end = events.find((e) => e.type === "compact-end")?.payload as { error?: string };
        expect(end.error).toContain("invalid api key");
        expect(events.some((e) => e.type === "error")).toBe(false);
        expect(events.filter((e) => e.type === "text-delta").map((e) => e.payload)).toEqual(["done"]);
    });
});

describe("the summarizer's input", () => {
    const bulkyHistory = (): Entry[] => [
        msg("user", "fix the parser"),
        {
            type: "message",
            role: "assistant",
            ts: 0,
            content: [
                {
                    type: "reasoning",
                    text: "SECRET CHAIN OF THOUGHT",
                    providerOptions: { xai: { encrypted: "BLOB".repeat(500) } },
                },
                { type: "tool-call", toolCallId: "r1", toolName: "read", input: { path: "src/parser.ts" } },
            ],
        } as Entry,
        {
            type: "message",
            role: "tool",
            ts: 0,
            content: [
                {
                    type: "tool-result",
                    toolCallId: "r1",
                    toolName: "read",
                    output: { type: "text", value: `HEAD${"x".repeat(20_000)}TAIL` },
                },
            ],
        } as Entry,
        ...Array.from({ length: 6 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `later ${i}`)),
    ];

    test("carries no reasoning, no provider blobs, and only the ends of a long tool result", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        currentModel = new MockLanguageModelV3({ doGenerate: async () => summaryReply("S") });
        const { runCompact } = await import("../src/agent/compact");
        // Manual: the history is under the kept window, and this is about the input.
        await runCompact({ session: mkSession(dir, bulkyHistory()), modelId: MODEL, manual: true });
        const prompt = JSON.stringify(currentModel.doGenerateCalls[0].prompt);
        expect(prompt).not.toContain("SECRET CHAIN OF THOUGHT");
        expect(prompt).not.toContain("BLOB");
        expect(prompt).toContain("HEAD");
        expect(prompt).toContain("TAIL");
        expect(prompt).toContain("chars omitted");
        expect(prompt).toContain("→ read(");
        expect(prompt.length).toBeLessThan(12_000);
    });

    test("a request refused as too big is split into a rolling summary", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        const history = Array.from({ length: 14 }, (_, i) =>
            msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} ${"y".repeat(2_500)}`),
        );
        let calls = 0;
        currentModel = new MockLanguageModelV3({
            doGenerate: async () => {
                calls++;
                if (calls === 1) {
                    throw new APICallError({
                        message: "Request Entity Too Large",
                        url: "https://example.test",
                        requestBodyValues: {},
                        statusCode: 413,
                        isRetryable: false,
                    });
                }
                return summaryReply(`SUMMARY-${calls}`);
            },
        });
        const { runCompact } = await import("../src/agent/compact");
        const session = mkSession(dir, history);
        // A 10k window → the minimum budget, so ten ~2.5k messages need chunks.
        const result = await runCompact({ session, modelId: MODEL, contextWindow: 10_000 });

        const prompts = currentModel.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
        expect(prompts.length).toBeGreaterThan(2); // the refusal, then 2+ chunks
        // Each chunk after the first reads the summary so far.
        expect(prompts[2]).toContain("SUMMARY-2");
        expect(result.summary).toBe(`SUMMARY-${calls}`);
        expect((session.entries().find((e) => e.type === "compact") as { summary: string }).summary).toBe(
            result.summary,
        );
    });

    test("a refusal for any other reason is not retried", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        currentModel = new MockLanguageModelV3({
            doGenerate: async () => {
                throw new APICallError({
                    message: "invalid api key",
                    url: "https://example.test",
                    requestBodyValues: {},
                    statusCode: 401,
                    isRetryable: false,
                });
            },
        });
        const { runCompact } = await import("../src/agent/compact");
        await expect(runCompact({ session: mkSession(dir, oldHistory()), modelId: MODEL })).rejects.toThrow(
            "invalid api key",
        );
        expect(currentModel.doGenerateCalls).toHaveLength(1);
    });
});

describe("the summary", () => {
    const toolCall = (toolName: string, path: string): Entry =>
        ({
            type: "message",
            role: "assistant",
            ts: 0,
            content: [{ type: "tool-call", toolCallId: `${toolName}-${path}`, toolName, input: { path } }],
        }) as Entry;
    const toolResult = (toolName: string, path: string): Entry =>
        ({
            type: "message",
            role: "tool",
            ts: 0,
            content: [
                {
                    type: "tool-result",
                    toolCallId: `${toolName}-${path}`,
                    toolName,
                    output: { type: "text", value: "ok" },
                },
            ],
        }) as Entry;
    /** A request that reads one file and edits another, padded past the kept window. */
    const work = (n: number): Entry[] => [
        msg("user", `request ${n}: tidy module ${n}`),
        toolCall("read", `src/read-${n}.ts`),
        toolResult("read", `src/read-${n}.ts`),
        toolCall("edit", `src/edit-${n}.ts`),
        toolResult("edit", `src/edit-${n}.ts`),
        msg("assistant", `done with ${n} ${"w".repeat(90_000)}`),
    ];
    const promptOf = (call: number) => JSON.stringify(currentModel!.doGenerateCalls[call].prompt);

    test("is a structured checkpoint that quotes the user and lists the files from the tool calls", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        currentModel = new MockLanguageModelV3({ doGenerate: async () => summaryReply("## Goal\nTidy.") });
        const { runCompact } = await import("../src/agent/compact");
        const session = mkSession(dir, [...work(1), ...work(2)]);
        await runCompact({ session, modelId: MODEL });

        const prompt = promptOf(0);
        expect(prompt).toContain("Do NOT continue the conversation");
        expect(prompt).toContain("<conversation>");
        expect(prompt).toContain("## User Messages");
        expect(prompt).not.toContain("<previous-summary>");
        const entry = session.entries().find((e) => e.type === "compact") as {
            summary: string;
            details: { readFiles: string[]; modifiedFiles: string[] };
        };
        expect(entry.summary).toContain("<read-files>\nsrc/read-1.ts");
        expect(entry.summary).toContain("<modified-files>\nsrc/edit-1.ts");
        expect(entry.details.modifiedFiles).toContain("src/edit-1.ts");
    });

    test("a second compaction folds the new messages into the previous summary, file lists carried", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        let n = 0;
        currentModel = new MockLanguageModelV3({ doGenerate: async () => summaryReply(`SUMMARY-${++n}`) });
        const { runCompact } = await import("../src/agent/compact");
        const session = mkSession(dir, [...work(1), ...work(2)]);
        await runCompact({ session, modelId: MODEL });
        for (const e of [...work(3), ...work(4)]) await session.append(e);
        await runCompact({ session, modelId: MODEL });

        const second = promptOf(1);
        expect(second).toContain("<previous-summary>\\nSUMMARY-1\\n</previous-summary>");
        // The lists are rebuilt from the calls, never handed back to be re-summarized.
        expect(second).not.toContain("<read-files>");
        expect(second).toContain("NEW messages");
        const latest = session
            .entries()
            .filter((e) => e.type === "compact")
            .at(-1) as { summary: string };
        expect(latest.summary).toContain("src/edit-1.ts");
        expect(latest.summary).toContain("src/edit-3.ts");
    });

    test("keeps the recent window word for word and counts it in tokensAfter", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        currentModel = new MockLanguageModelV3({ doGenerate: async () => summaryReply("S") });
        const { runCompact } = await import("../src/agent/compact");
        const session = mkSession(dir, [...work(1), ...work(2)]);
        const result = await runCompact({ session, modelId: MODEL });
        const messages = session.messages();
        const keptTokens = messages
            .slice(result.cutAt)
            .reduce((sum, m) => sum + JSON.stringify(m.content).length / 4, 0);
        expect(result.cutAt).toBeGreaterThan(0);
        expect(keptTokens).toBeGreaterThanOrEqual(20_000);
        expect(messages[result.cutAt].role).not.toBe("tool");
        expect(result.tokensAfter).toBeGreaterThan(20_000);
    });

    test("a request bigger than the kept window is cut inside it, and the summary is told so", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        currentModel = new MockLanguageModelV3({ doGenerate: async () => summaryReply("S") });
        const { runCompact } = await import("../src/agent/compact");
        const session = mkSession(dir, [
            msg("user", "one long request"),
            ...Array.from({ length: 4 }, (_, i) => msg("assistant", `step ${i} ${"v".repeat(40_000)}`)),
        ]);
        const result = await runCompact({ session, modelId: MODEL });
        expect(session.messages()[result.cutAt].role).toBe("assistant");
        expect(promptOf(0)).toContain("still in progress");
    });

    test("/compact <focus> steers it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        currentModel = new MockLanguageModelV3({ doGenerate: async () => summaryReply("S") });
        const { runCompact } = await import("../src/agent/compact");
        await runCompact({ session: mkSession(dir, work(1)), modelId: MODEL, manual: true, focus: "the API changes" });
        expect(promptOf(0)).toContain("Additional focus: the API changes");
    });

    test("an explicit /compact on a short session still summarizes all of it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        currentModel = new MockLanguageModelV3({ doGenerate: async () => summaryReply("S") });
        const { runCompact } = await import("../src/agent/compact");
        const session = mkSession(dir, [msg("user", "hi"), msg("assistant", "hello")]);
        expect((await runCompact({ session, modelId: MODEL })).cutAt).toBe(0);
        expect((await runCompact({ session, modelId: MODEL, manual: true })).cutAt).toBe(2);
    });

    test("a summary cut off at the output limit is refused, not saved", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-compact-"));
        currentModel = new MockLanguageModelV3({
            doGenerate: async () => ({
                ...summaryReply("## Goal\nhalf a summ"),
                finishReason: { unified: "length" as const, raw: "max_tokens" },
            }),
        });
        const { runCompact } = await import("../src/agent/compact");
        const session = mkSession(dir, [...work(1), ...work(2)]);
        await expect(runCompact({ session, modelId: MODEL })).rejects.toThrow("output limit");
        expect(session.entries().some((e) => e.type === "compact")).toBe(false);
    });
});

describe("a request refused as too big for the window", () => {
    const tooLong = () => ({
        type: "error",
        error: new APICallError({
            message: "prompt is too long: 300000 tokens > 256000 maximum",
            url: "https://example.test",
            requestBodyValues: {},
            statusCode: 400,
            isRetryable: false,
        }),
    });

    test("is compacted and retried, and the user never sees the refusal", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-overflow-"));
        let streams = 0;
        currentModel = new MockLanguageModelV3({
            doStream: async () => (streams++ === 0 ? streamOf([tooLong()]) : streamOf(answer("done"))),
            doGenerate: async () => summaryReply("SUMMARY"),
        });
        const events = await runTurnWith(mkSession(dir, oldHistory()), dir);
        expect(events.filter((e) => e.type !== "text-delta").map((e) => e.type)).toEqual([
            "compact-start",
            "compact-end",
            "finish",
        ]);
        expect(JSON.stringify(currentModel.doStreamCalls[1].prompt)).toContain("SUMMARY");
    });

    test("is retried once: a second refusal is reported", async () => {
        const dir = mkdtempSync(join(tmpdir(), "loop-overflow-"));
        currentModel = new MockLanguageModelV3({
            doStream: async () => streamOf([tooLong()]),
            doGenerate: async () => summaryReply("SUMMARY"),
        });
        const events = await runTurnWith(mkSession(dir, oldHistory()), dir);
        expect(currentModel.doStreamCalls).toHaveLength(2);
        expect(events.filter((e) => e.type === "compact-start")).toHaveLength(1);
        expect(events.filter((e) => e.type === "error")).toHaveLength(1);
        expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
    });
});
