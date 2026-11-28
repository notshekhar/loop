/**
 * What an imported chat cost: the calls read from each agent's own records,
 * the estimate when there are none, the price at fixed $/MTok, and the
 * ledger rows a save writes (temp session DB).
 */
import { describe, expect, test } from "bun:test";
import { claudeCalls, codexCalls, estimatedCalls } from "../src/extensions/builtin/chat-import/usage";
import { estimateChatCost, type ModelPricer } from "../src/extensions/builtin/chat-import/cost";
import type { ChatSource } from "../src/extensions/builtin/chat-import/source";
import {
    findChatImport,
    getDb,
    importedChatIds,
    recordChatImport,
    SessionManager,
    sumLedgerForSession,
} from "../src/sessions";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
});
const claude = (id: string, model: string, u: ReturnType<typeof usage>, ts = "2026-11-01T10:00:00Z") => ({
    type: "assistant",
    timestamp: ts,
    message: { id, model, usage: u },
});
const tokenCount = (input: number, cached: number, output: number) => ({
    type: "event_msg",
    timestamp: "2026-11-02T09:00:00Z",
    payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
    },
});

describe("Claude Code calls", () => {
    test("a message split over several records counts once; <synthetic> never counts", () => {
        const calls = claudeCalls([
            claude("m1", "claude-opus-5-5", usage(5, 100, 2000, 300)),
            claude("m1", "claude-opus-5-5", usage(5, 100, 2000, 300)),
            claude("m2", "<synthetic>", usage(0, 0)),
            { type: "user", message: { id: "u", usage: usage(9, 9) } },
            claude("m3", "claude-haiku-4-5", usage(1, 2)),
        ]);
        expect(calls.map((c) => [c.model, c.tokens])).toEqual([
            ["claude-opus-5-5", { input: 5, cacheRead: 2000, cacheWrite: 300, output: 100 }],
            ["claude-haiku-4-5", { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }],
        ]);
        expect(calls[0]!.ts).toBe(Date.parse("2026-11-01T10:00:00Z"));
    });
});

describe("Codex calls", () => {
    test("each call is the change in the running total; a repeated event counts nothing", () => {
        const calls = codexCalls([
            { type: "turn_context", payload: { model: "gpt-5.5" } },
            tokenCount(1000, 0, 50),
            tokenCount(1000, 0, 50),
            tokenCount(2500, 900, 80),
        ]);
        expect(calls.map((c) => [c.model, c.tokens.input, c.tokens.cacheRead, c.tokens.output])).toEqual([
            ["gpt-5.5", 1000, 0, 50],
            ["gpt-5.5", 600, 900, 30],
        ]);
    });
});

describe("estimated calls", () => {
    test("each assistant step re-reads what came before and writes itself, ~4 chars a token", () => {
        const entries = [
            { type: "message", role: "user", content: "x".repeat(400), ts: 1 },
            { type: "message", role: "assistant", content: [{ type: "text", text: "y".repeat(80) }], ts: 2 },
            { type: "message", role: "user", content: "z".repeat(40), ts: 3 },
            { type: "message", role: "assistant", content: [{ type: "text", text: "w".repeat(8) }], ts: 4 },
        ] as Entry[];
        expect(estimatedCalls(entries).map((c) => [c.ts, c.tokens.input, c.tokens.output, c.estimated])).toEqual([
            [2, 100, 20, true],
            [4, 130, 2, true],
        ]);
    });
});

const PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const pricer: ModelPricer = {
    vendorPrices: async (id) => (id === "anthropic/claude-sonnet-4-5" ? PRICES : undefined),
    loopPrices: async (id) =>
        id === "xai/grok-4" ? { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2 } : undefined,
};
const source = (pricing: ChatSource["pricing"]) => ({ id: "x", label: "X", pricing }) as unknown as ChatSource;

describe("pricing", () => {
    test("real counts at the vendor's $/MTok, cache reads and writes at their own rates", async () => {
        const chat = {
            id: "c",
            title: "t",
            entries: [],
            calls: claudeCalls([claude("m1", "claude-sonnet-4-5", usage(1_000_000, 100_000, 1_000_000, 100_000))]),
        };
        const cost = await estimateChatCost(
            chat as never,
            source({ agent: "claude-code", vendor: "anthropic" }),
            "xai/grok-4",
            pricer,
        );
        // 1M·$3 + 0.1M·$15 + 1M·$0.30 + 0.1M·$3.75
        expect(cost.usd).toBeCloseTo(3 + 1.5 + 0.3 + 0.375, 6);
        expect(cost).toMatchObject({
            inputTokens: 2_100_000,
            outputTokens: 100_000,
            cacheReadTokens: 1_000_000,
            approximate: false,
        });
        expect(cost.calls[0]).toMatchObject({
            model: "claude-code/claude-sonnet-4-5",
            prices: PRICES,
            estimated: false,
        });
        expect(cost.byModel).toEqual(["claude-sonnet-4-5 · 1 call · $5.17"]);
    });

    test("a source that names no model is priced at loop's model, and says so", async () => {
        const entries = [
            { type: "message", role: "user", content: "x".repeat(4_000_000), ts: 1 },
            { type: "message", role: "assistant", content: [{ type: "text", text: "y".repeat(400_000) }], ts: 2 },
        ] as Entry[];
        const cost = await estimateChatCost(
            { id: "c", title: "t", entries } as never,
            source({ agent: "cursor-agent" }),
            "xai/grok-4",
            pricer,
        );
        expect(cost.usd).toBeCloseTo(1 * 2 + 0.1 * 10, 6);
        expect(cost.approximate).toBe(true);
        expect(cost.calls[0]!.model).toBe("cursor-agent/grok-4");
        expect(cost.byModel[0]).toContain("at grok-4's prices");
    });

    test("an unknown model costs $0 and the estimate is marked approximate", async () => {
        const chat = {
            id: "c",
            title: "t",
            entries: [],
            calls: claudeCalls([claude("m1", "mystery-1", usage(10, 10))]),
        };
        const cost = await estimateChatCost(
            chat as never,
            source({ agent: "claude-code", vendor: "anthropic" }),
            "xai/grok-4",
            pricer,
        );
        expect(cost.usd).toBe(0);
        expect(cost.approximate).toBe(true);
        expect(cost.byModel).toEqual(["mystery-1 · 1 call · no price known"]);
    });
});

describe("import records", () => {
    test("a save files one ledger row per call, out of the rollups when estimated, and is found again", async () => {
        const session = await new SessionManager().create({ cwd: "/w", provider: "xai", model: "xai/m" });
        const call = (estimated: boolean) => ({
            ts: Date.UTC(2026, 9, 5),
            model: "cursor-agent/grok-4",
            usage: { inputTokens: 100, outputTokens: 10 },
            usd: 0.01,
            prices: { input: 2, output: 10 },
            estimated,
        });
        recordChatImport({
            source: "cursor",
            chatId: "k1",
            sessionPub: session.id,
            cwd: "/w",
            calls: [call(true), call(false)],
        });
        expect(sumLedgerForSession(session.id)).toMatchObject({ rows: 2, inputTokens: 200, outputTokens: 20 });
        const rows = getDb()
            .query<{ day: string; source: string; estimated: number }, [string]>(
                "SELECT day, source, estimated FROM cost_ledger WHERE session_pub = ? ORDER BY estimated",
            )
            .all(session.id);
        expect(rows).toEqual([
            { day: "2026-10-05", source: "import", estimated: 0 },
            { day: "2026-10-05", source: "import", estimated: 1 },
        ]);
        expect(findChatImport("cursor", "k1")).toBe(session.id);
        expect([...importedChatIds("cursor")]).toEqual(["k1"]);
        expect(findChatImport("codex", "k1")).toBeUndefined();
    });

    test("a chat whose session was deleted counts as not imported", async () => {
        const manager = new SessionManager();
        const session = await manager.create({ cwd: "/w", provider: "xai", model: "xai/m" });
        recordChatImport({ source: "codex", chatId: "gone", sessionPub: session.id, cwd: "/w", calls: [] });
        getDb().run("DELETE FROM sessions WHERE pub_id = ?", [session.id]);
        expect(findChatImport("codex", "gone")).toBeUndefined();
        expect(importedChatIds("codex").size).toBe(0);
    });
});
