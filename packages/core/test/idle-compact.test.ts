/**
 * Idle compaction: a conversation over the threshold is summarized once the
 * turn has sat idle for the cache lifetime, through one request that is the
 * turn's own conversation plus an instruction (so the provider reads it from
 * cache); a new turn cancels it; a small conversation never schedules one.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const settings: Record<string, unknown> = {};
const realSettings = await import("../src/settings");
const realGetSetting = realSettings.getSetting;
mock.module("../src/settings", () => ({
    ...realSettings,
    getSetting: (key: string) => (key in settings ? settings[key] : realGetSetting(key as never)),
}));
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
const realGetModel = realProviders.getModel;
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) => currentModel ?? realGetModel(...args),
}));

const { SessionManager } = await import("../src/sessions");
const { runTurn, CostTracker } = await import("../src/agent");
const { getCatalog } = await import("../src/catalog");
const idle = await import("../src/agent/idle-compact");

const MODEL = "xai/grok-build-0.1"; // xAI caches prompts on its own: idle compaction applies
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function usage(input: number) {
    return {
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
    };
}

function answer(text: string, input: number) {
    return {
        stream: new ReadableStream({
            start(c) {
                c.enqueue({ type: "text-start", id: "t" });
                c.enqueue({ type: "text-delta", id: "t", delta: text });
                c.enqueue({ type: "text-end", id: "t" });
                c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: usage(input) });
                c.close();
            },
        }),
    };
}

describe("idle compaction", () => {
    let dir: string;
    let window: number;
    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), "loop-idle-"));
        window = (await getCatalog())[MODEL]?.contextWindow ?? 0;
        idle.setIdleCompactDelayForTests(50);
    });
    afterEach(() => {
        idle.setIdleCompactDelayForTests(null);
        currentModel = null;
        for (const key of Object.keys(settings)) delete settings[key];
    });

    const turn = async (session: Awaited<ReturnType<SessionManager["create"]>>, text: string) =>
        runTurn({
            session,
            modelId: MODEL,
            userInput: text,
            cwd: dir,
            tracker: new CostTracker(),
            emitter: new EventEmitter() as never,
        });

    test("a conversation over 70% is summarized once idle, from the turn's own cached request", async () => {
        expect(window).toBeGreaterThan(0);
        const summaryCalls: any[] = [];
        currentModel = new MockLanguageModelV3({
            doStream: async () => answer("here is a long answer", Math.ceil(window * 0.8)),
            doGenerate: async (call: any) => {
                summaryCalls.push(call);
                return {
                    content: [{ type: "text", text: "## Goal\nShip it.\n## Current state\nDone." }],
                    finishReason: { unified: "stop", raw: "end_turn" },
                    usage: usage(Math.ceil(window * 0.8)),
                    warnings: [],
                };
            },
        });
        const session = await new SessionManager().create({ cwd: dir, provider: "xai", model: MODEL });
        // History well past what compaction keeps word for word (~20k tokens).
        for (let i = 0; i < 24; i++) {
            await session.append({
                type: "message",
                role: "user",
                content: `question ${i} ${"x".repeat(4000)}`,
                ts: Date.now(),
            });
            await session.append({
                type: "message",
                role: "assistant",
                content: `answer ${i} ${"y".repeat(4000)}`,
                ts: Date.now(),
            });
        }
        await turn(session, "build the thing");
        expect(idle.hasPendingIdleCompact(session.id)).toBe(true);
        await sleep(400);

        expect(summaryCalls).toHaveLength(1);
        const call = summaryCalls[0];
        // The cached conversation, then one instruction — not a re-written transcript.
        const prompt = JSON.stringify(call.prompt);
        expect(prompt).toContain("build the thing");
        expect(prompt).toContain("here is a long answer");
        expect(JSON.stringify(call.prompt.at(-1))).toContain("gone idle");
        // The turn's tools are still sent, so the cached prefix matches — but never called.
        expect((call.tools ?? []).length).toBeGreaterThan(0);
        expect(call.toolChoice).toEqual({ type: "none" });

        const compact = session.getBranch().find((e) => e.type === "compact") as
            { summary: string; trigger?: string } | undefined;
        expect(compact?.trigger).toBe("idle");
        expect(compact?.summary).toContain("Ship it.");
    });

    test("a new message cancels it", async () => {
        let summaries = 0;
        currentModel = new MockLanguageModelV3({
            doStream: async () => answer("ok", Math.ceil(window * 0.8)),
            doGenerate: async () => {
                summaries++;
                throw new Error("should not run");
            },
        });
        idle.setIdleCompactDelayForTests(300);
        const session = await new SessionManager().create({ cwd: dir, provider: "xai", model: MODEL });
        await turn(session, "first");
        // A message lands before the cache would lapse; its turn is big too,
        // so it schedules a fresh one — cancel that and confirm nothing ran.
        await turn(session, "second");
        idle.cancelIdleCompact(session.id);
        await sleep(450);
        expect(summaries).toBe(0);
        expect(session.getBranch().some((e) => e.type === "compact")).toBe(false);
    });

    test("a conversation under the threshold — or with the setting off — never schedules one", async () => {
        currentModel = new MockLanguageModelV3({ doStream: async () => answer("ok", Math.ceil(window * 0.1)) });
        const small = await new SessionManager().create({ cwd: dir, provider: "xai", model: MODEL });
        await turn(small, "hi");
        expect(idle.hasPendingIdleCompact(small.id)).toBe(false);

        settings.idleCompact = false;
        currentModel = new MockLanguageModelV3({ doStream: async () => answer("ok", Math.ceil(window * 0.9)) });
        const off = await new SessionManager().create({ cwd: dir, provider: "xai", model: MODEL });
        await turn(off, "hi");
        expect(idle.hasPendingIdleCompact(off.id)).toBe(false);
    });

    test("only providers with prompt caching", () => {
        expect(idle.idleCompactDelayMs({ provider: "ollama", anthropicCaching: false })).toBeNull();
        expect(idle.idleCompactDelayMs({ provider: "openai", anthropicCaching: false })).not.toBeNull();
        expect(idle.idleCompactDelayMs({ provider: "custom:x", anthropicCaching: true })).not.toBeNull();
    });
});

describe("idle compaction in the transcript", async () => {
    const { applyEvent, emptyTranscript } = await import("../src/transcript");
    test("a marker between turns that never marks the chat running, and vanishes if the user came back", () => {
        let t = applyEvent(emptyTranscript(), { type: "compact-start", data: { reason: "idle" } }, 1);
        expect(t.running).toBe(false);
        expect(t.messages.map((m) => [m.role, m.parts[0]?.type])).toEqual([["system", "data-compaction"]]);
        const done = applyEvent(
            t,
            { type: "compact-end", data: { summary: "s", cutAt: 3, tokensBefore: 900, tokensAfter: 100 } },
            2,
        );
        expect(done.messages[0]!.parts[0]).toMatchObject({
            data: { running: false, reason: "idle", tokensAfter: 100 },
        });
        // Cancelled by a turn the user started: the marker goes, the turn stays.
        t = applyEvent(t, { type: "user-message", data: { id: "u1", text: "back", ts: 3 } }, 3);
        t = applyEvent(t, { type: "compact-end", data: { summary: "", cutAt: 0, tokensBefore: 0, aborted: true } }, 4);
        expect(t.messages.map((m) => m.role)).toEqual(["user"]);
    });
});
