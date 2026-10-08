import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { Session } from "../src/sessions";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// One delegating providers mock for the whole file: bun module mocks leak
// across test files, and already-bound importers can't be un-mocked later
// (mock.restore() doesn't touch module mocks) — so the mock stays installed
// but getModel is only fake while a test sets currentModel. See rpc.test.ts.
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
        currentModel ?? realProviders.getModel(...args),
}));

// Streams reasoning deltas, then text deltas, slowly — like a reasoning model
// that "thinks" before writing the answer. A turn can be interrupted in either
// phase to check what survives.
function reasoningThenText(reasoning: string, text: string) {
    const events: any[] = [
        { type: "reasoning-start", id: "r0" },
        ...reasoning.split("").map((c) => ({ type: "reasoning-delta", id: "r0", delta: c })),
        { type: "reasoning-end", id: "r0" },
        { type: "text-start", id: "t0" },
        ...text.split("").map((c) => ({ type: "text-delta", id: "t0", delta: c })),
        { type: "text-end", id: "t0" },
        {
            type: "finish",
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
    ];
    let i = 0;
    const stream = new ReadableStream({
        async pull(controller) {
            await new Promise((r) => setTimeout(r, 4));
            if (i < events.length) controller.enqueue(events[i++]);
            else controller.close();
        },
    });
    return { stream };
}

function mkSession(dir: string, modelId: string) {
    return new Session({ id: "t", createdAt: 0, cwd: dir, provider: "xai", model: modelId }, join(dir, "s.jsonl"), []);
}

const MODEL = "xai/grok-build-0.1";

describe("partial output is persisted when a turn is aborted mid-stream", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-abort-"));
    });
    afterEach(() => {
        currentModel = null;
        mock.restore();
    });

    async function runUntilAborted(opts: {
        reasoning: string;
        text: string;
        abortOn: "reasoning" | "text";
        afterChars: number;
    }) {
        const model = new MockLanguageModelV3({
            doStream: async () => reasoningThenText(opts.reasoning, opts.text),
        });
        currentModel = model;
        const { runTurn, CostTracker } = await import("../src/agent");

        const session = mkSession(dir, MODEL);
        const abort = new AbortController();
        const em = new EventEmitter() as any;
        let seen = "";
        const evt = opts.abortOn === "reasoning" ? "reasoning-delta" : "text-delta";
        em.on(evt, (t: string) => {
            seen += t;
            if (seen.length >= opts.afterChars) abort.abort();
        });
        const tracker = new CostTracker();
        await runTurn({
            session,
            modelId: MODEL,
            userInput: "write me a 1000 line poem",
            cwd: dir,
            abortSignal: abort.signal,
            tracker,
            emitter: em,
        });
        const assistant = session.entries().find((e: any) => e.type === "message" && e.role === "assistant") as any;
        return { assistant, seen, tracker, session };
    }

    test("aborting during the thinking phase persists the partial reasoning", async () => {
        const { assistant, seen } = await runUntilAborted({
            reasoning: "Let me think about the poem's structure carefully",
            text: "Roses are red",
            abortOn: "reasoning",
            afterChars: 6,
        });
        expect(assistant).toBeDefined();
        const parts = assistant.content as Array<{ type: string; text: string }>;
        const reasoning = parts.find((p) => p.type === "reasoning");
        expect(reasoning).toBeDefined();
        expect(reasoning!.text).toBe(seen);
        // No text streamed yet, so there's no text part.
        expect(parts.some((p) => p.type === "text")).toBe(false);
    });

    test("aborting during the answer keeps both the reasoning and the partial text", async () => {
        const { assistant } = await runUntilAborted({
            reasoning: "Short think",
            text: "Roses are red and violets are blue",
            abortOn: "text",
            afterChars: 8,
        });
        expect(assistant).toBeDefined();
        const parts = assistant.content as Array<{ type: string; text: string }>;
        const reasoning = parts.find((p) => p.type === "reasoning");
        const text = parts.find((p) => p.type === "text");
        expect(reasoning?.text).toBe("Short think");
        expect(text).toBeDefined();
        expect(text!.text.length).toBeGreaterThan(0);
        expect("Roses are red and violets are blue".startsWith(text!.text)).toBe(true);
    });

    test("an interrupted turn is flagged and its cut-off request cost is estimated", async () => {
        const { assistant, tracker } = await runUntilAborted({
            reasoning: "Short think",
            text: "Roses are red and violets are blue",
            abortOn: "text",
            afterChars: 8,
        });
        // #2: the turn is marked interrupted so the next request's context
        // reflects it (and toModelMessages never silently drops it).
        expect(assistant.interrupted).toBe(true);
        // #1: no finish-step fired for the cut-off request, so the SDK reports
        // no usage (vercel/ai#7805) — loop attaches an estimate, flagged as one.
        expect(assistant.usage?.estimated).toBe(true);
        expect(assistant.usage?.outputTokens).toBeGreaterThan(0);
        // The estimate lands in the session total only, surfaced with a `~`.
        expect(tracker.format().startsWith("~$")).toBe(true);
        expect(tracker.sessionBreakdown().estimated).toBe(true);
    });

    test("the interruption is surfaced in the model context, not dropped", async () => {
        const { session } = await runUntilAborted({
            reasoning: "Short think",
            text: "Roses are red",
            abortOn: "text",
            afterChars: 4,
        });
        const { toModelMessages } = await import("../src/agent/model-messages");
        const msgs = toModelMessages(session);
        const last = msgs[msgs.length - 1];
        expect(last.role).toBe("assistant");
        // The next turn's context carries the interruption note rather than a
        // gap, so the agent knows its previous answer was cut off.
        expect(JSON.stringify(last.content)).toContain("interrupted this response");
    });
});

// A native agent (Claude Code, Cursor) runs its tools itself, inside ONE model
// call: the whole turn is a single step. Interrupting it used to keep only the
// trailing text and lose every tool that had already run.
describe("an interrupted native-agent turn keeps the tools that completed", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-abort-native-"));
    });
    afterEach(() => {
        currentModel = null;
        mock.restore();
    });

    const marker = { nativeAgent: { provider: "claude-code" } };
    function nativeTurn() {
        const events: any[] = [
            { type: "text-start", id: "t0" },
            { type: "text-delta", id: "t0", delta: "Looking around." },
            { type: "text-end", id: "t0" },
            { type: "tool-input-start", id: "c1", toolName: "bash", providerExecuted: true, dynamic: true },
            { type: "tool-input-end", id: "c1" },
            {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "bash",
                input: JSON.stringify({ command: "ls" }),
                providerExecuted: true,
                dynamic: true,
                providerMetadata: marker,
            },
            { type: "tool-result", toolCallId: "c1", toolName: "bash", result: "README.md", dynamic: true, providerMetadata: marker },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Now the tests." },
            { type: "text-end", id: "t1" },
            { type: "tool-input-start", id: "c2", toolName: "bash", providerExecuted: true, dynamic: true },
            { type: "tool-input-end", id: "c2" },
            {
                type: "tool-call",
                toolCallId: "c2",
                toolName: "bash",
                input: JSON.stringify({ command: "bun test" }),
                providerExecuted: true,
                dynamic: true,
                providerMetadata: marker,
            },
            // Interrupted here: c2 never gets a result.
            { type: "tool-result", toolCallId: "c2", toolName: "bash", result: "never seen", dynamic: true, providerMetadata: marker },
            { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ];
        let i = 0;
        return {
            stream: new ReadableStream({
                async pull(controller) {
                    await new Promise((r) => setTimeout(r, 4));
                    if (i < events.length) controller.enqueue(events[i++]);
                    else controller.close();
                },
            }),
        };
    }

    test("completed tool calls survive Esc in place; the one still running does not", async () => {
        currentModel = new MockLanguageModelV3({ doStream: async () => nativeTurn() });
        const { runTurn, CostTracker } = await import("../src/agent");
        const session = mkSession(dir, MODEL);
        const abort = new AbortController();
        const em = new EventEmitter() as any;
        em.on("tool-call", (part: { toolCallId?: string }) => {
            if (part.toolCallId === "c2") abort.abort();
        });
        await runTurn({
            session,
            modelId: MODEL,
            userInput: "look around and run the tests",
            cwd: dir,
            abortSignal: abort.signal,
            tracker: new CostTracker(),
            emitter: em,
        });

        const assistant = session.entries().find((e: any) => e.type === "message" && e.role === "assistant") as any;
        expect(assistant.interrupted).toBe(true);
        const parts = assistant.content as Array<{ type: string; toolCallId?: string; text?: string; output?: unknown }>;
        expect(parts.map((p) => p.type)).toEqual(["text", "tool-call", "tool-result", "text"]);
        expect(parts[1]).toMatchObject({ toolCallId: "c1", toolName: "bash", input: { command: "ls" }, providerExecuted: true });
        expect(parts[2]).toMatchObject({ toolCallId: "c1", output: { type: "text", value: "README.md" } });
        expect(parts.some((p) => p.toolCallId === "c2")).toBe(false);
    });
});
