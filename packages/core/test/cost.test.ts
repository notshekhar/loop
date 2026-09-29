import { describe, expect, test } from "bun:test";
import { CostTracker, outputUsd, stampUsageCost, sumUsage } from "../src/agent/cost";
import { stepMessagesToEntries } from "../src/agent";
import { Session } from "../src/sessions";
import type { Entry, UsageBlock } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const usage = (input: number, output: number, total?: number): UsageBlock => ({
    inputTokens: input,
    outputTokens: output,
    totalTokens: total ?? input + output,
});

describe("outputUsd — reasoning-rate models", () => {
    test("no reasoning rate: all output tokens bill at the output price", () => {
        const u: UsageBlock = { outputTokens: 1_000_000, outputTokenDetails: { reasoningTokens: 400_000 } };
        expect(outputUsd({ output: 2 }, u)).toBeCloseTo(2, 10);
    });

    test("reasoning rate splits the bill: text at output price, reasoning at its own", () => {
        // 600k text @ $2 + 400k reasoning @ $8 = 1.2 + 3.2
        const u: UsageBlock = { outputTokens: 1_000_000, outputTokenDetails: { reasoningTokens: 400_000 } };
        expect(outputUsd({ output: 2, reasoning: 8 }, u)).toBeCloseTo(4.4, 10);
    });

    test("provider-reported textTokens wins over the subtraction", () => {
        const u: UsageBlock = {
            outputTokens: 1_000_000,
            outputTokenDetails: { textTokens: 500_000, reasoningTokens: 400_000 },
        };
        // 500k @ $2 + 400k @ $8 = 1 + 3.2
        expect(outputUsd({ output: 2, reasoning: 8 }, u)).toBeCloseTo(4.2, 10);
    });

    test("reasoning reported OUTSIDE outputTokens bills both fully (clamped subtraction)", () => {
        const u: UsageBlock = { outputTokens: 100_000, outputTokenDetails: { reasoningTokens: 400_000 } };
        // text = max(0, 100k - 400k) = 0 → 0 @ $2 + 400k @ $8
        expect(outputUsd({ output: 2, reasoning: 8 }, u)).toBeCloseTo(3.2, 10);
    });

    test("v6 flat reasoningTokens field is honored", () => {
        const u: UsageBlock = { outputTokens: 1_000_000, reasoningTokens: 400_000 };
        expect(outputUsd({ output: 2, reasoning: 8 }, u)).toBeCloseTo(4.4, 10);
    });

    test("zero reasoning tokens: plain output pricing even with a rate set", () => {
        const u: UsageBlock = { outputTokens: 1_000_000 };
        expect(outputUsd({ output: 2, reasoning: 8 }, u)).toBeCloseTo(2, 10);
    });
});

describe("CostTracker.seedFromEntries", () => {
    test("sums token usage and reports last turn ctx", () => {
        const t = new CostTracker();
        const { ctxTokens } = t.seedFromEntries("xai/grok-build-0.1", [usage(100, 20), usage(300, 50, 420)]);
        const s = t.sessionBreakdown();
        expect(s.inputTokens).toBe(400);
        expect(s.outputTokens).toBe(70);
        expect(ctxTokens).toBe(420);
    });

    test("empty transcript seeds zeros", () => {
        const t = new CostTracker();
        const { ctxTokens } = t.seedFromEntries("xai/grok-build-0.1", []);
        expect(ctxTokens).toBe(0);
        expect(t.sessionBreakdown().usd).toBe(0);
    });
});

describe("CostTracker.add", () => {
    // The subagent loop bills each step with tracker.add(modelId, usage) on
    // finish-step (including MCP-tool steps); this locks that those calls
    // accumulate into the session total rather than overwriting.
    // persist:false — tests must never write the user's real ~/.loop/cost.json.
    test("accumulates usage across calls (per-step billing)", () => {
        const t = new CostTracker({ persist: false });
        t.add("xai/grok-build-0.1", usage(100, 20));
        t.add("xai/grok-build-0.1", usage(300, 50));
        const s = t.sessionBreakdown();
        expect(s.inputTokens).toBe(400);
        expect(s.outputTokens).toBe(70);
    });

    test("addEstimated flags the session total and never clears once set", () => {
        const t = new CostTracker({ persist: false });
        t.add("xai/grok-build-0.1", usage(100, 20));
        expect(t.sessionBreakdown().estimated).toBeFalsy();
        t.addEstimated("xai/grok-build-0.1", { ...usage(50, 5), estimated: true });
        t.add("xai/grok-build-0.1", usage(10, 1));
        const s = t.sessionBreakdown();
        expect(s.estimated).toBe(true);
        expect(s.inputTokens).toBe(160);
    });
});

describe("CostTracker.seedFromSession", () => {
    test("includes assistant turns and subagent runs, skips others", () => {
        const entries: Entry[] = [
            { type: "message", role: "user", content: "hi", ts: 0 },
            { type: "message", role: "assistant", content: "yo", ts: 0, usage: usage(10, 5) },
            { type: "subagent", ts: 0, agent: "plan", prompt: "p", result: "r", usage: usage(200, 30) },
            { type: "message", role: "assistant", content: "done", ts: 0, usage: usage(40, 8) },
        ];
        const session = new Session(
            { id: "t", createdAt: 0, cwd: "/tmp", provider: "xai", model: "xai/grok-build-0.1" },
            "/tmp/fake.jsonl",
            entries,
        );
        const t = new CostTracker();
        const { ctxTokens } = t.seedFromSession(session);
        const s = t.sessionBreakdown();
        expect(s.inputTokens).toBe(250);
        expect(s.outputTokens).toBe(43);
        expect(ctxTokens).toBe(48); // last assistant turn
    });

    // Regression: tool entries carry no usage, so they must never be counted —
    // and each assistant usage is counted exactly once (the persistence bug
    // that re-saved cumulative messages doubled resumed cost).
    test("counts each assistant usage once; ignores tool messages", () => {
        const entries: Entry[] = [
            { type: "message", role: "user", content: "q", ts: 0 },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "a" }],
                ts: 0,
                usage: usage(100, 10),
            },
            { type: "message", role: "tool", content: [{ type: "tool-result" }], ts: 0 },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "b" }],
                ts: 0,
                usage: usage(120, 12),
            },
        ];
        const session = new Session(
            { id: "t", createdAt: 0, cwd: "/tmp", provider: "xai", model: "xai/grok-build-0.1" },
            "/tmp/fake.jsonl",
            entries,
        );
        const t = new CostTracker();
        t.seedFromSession(session);
        const s = t.sessionBreakdown();
        expect(s.inputTokens).toBe(220);
        expect(s.outputTokens).toBe(22);
    });

    // A compaction replaces the context the last usage measured: a session
    // resumed right after one must not report its pre-compaction size.
    test("ctx meter reports nothing measured when a compaction follows the last assistant turn", () => {
        const entries: Entry[] = [
            { type: "message", role: "user", content: "q", ts: 0 },
            { type: "message", role: "assistant", content: "a", ts: 0, usage: usage(170_000, 1_000) },
            { type: "compact", summary: "S", cutAt: 2, ts: 0, tokensBefore: 171_000, tokensAfter: 2_000 },
        ];
        const session = new Session(
            { id: "t", createdAt: 0, cwd: "/tmp", provider: "xai", model: "xai/grok-build-0.1" },
            "/tmp/fake.jsonl",
            entries,
        );
        expect(new CostTracker().seedFromSession(session).ctxTokens).toBe(0);
    });

    // The ctx meter tracks the MAIN conversation. A transcript that ends on a
    // subagent entry (aborted mid-task) must not adopt the subagent's context
    // size — its context window is separate from the parent's.
    test("ctx meter ignores a trailing subagent usage", () => {
        const entries: Entry[] = [
            { type: "message", role: "user", content: "hi", ts: 0 },
            { type: "message", role: "assistant", content: "a", ts: 0, usage: usage(40, 8) },
            { type: "subagent", ts: 0, agent: "plan", prompt: "p", result: "r", usage: usage(9000, 500) },
        ];
        const session = new Session(
            { id: "t", createdAt: 0, cwd: "/tmp", provider: "xai", model: "xai/grok-build-0.1" },
            "/tmp/fake.jsonl",
            entries,
        );
        const t = new CostTracker();
        const { ctxTokens } = t.seedFromSession(session);
        expect(ctxTokens).toBe(48); // last assistant turn, not the 9500-token subagent
        expect(t.sessionBreakdown().inputTokens).toBe(9040); // cost still counts both
    });
});

// Persisted entries carry the USD they were billed at (total + split), so a
// resumed session shows its true historical cost — not a re-price against
// whatever model/catalog the resuming machine happens to have (which showed
// $0 when the stamped model was unknown or swapped for a free one).
describe("usd stamping", () => {
    // fallback catalog: xai/grok-build-0.1 = $1/MTok in, $2/MTok out
    test("stampUsageCost stamps total and per-component split for a known model", () => {
        const stamped = stampUsageCost("xai/grok-build-0.1", usage(1_000_000, 500_000));
        expect(stamped.usd).toBeCloseTo(2, 6); // $1 input + $1 output
        expect(stamped.usdDetails?.input).toBeCloseTo(1, 6);
        expect(stamped.usdDetails?.output).toBeCloseTo(1, 6);
        expect(stamped.usdDetails?.cacheRead).toBe(0);
    });

    test("unknown model leaves the block unstamped so reads can still fall back", () => {
        const u = usage(100, 10);
        expect(stampUsageCost("nope/not-a-model", u)).toBe(u);
    });

    test("openrouter prefers the provider-reported cost for the total", () => {
        const stamped = stampUsageCost("openrouter/some-model", { ...usage(100, 10), cost: 0.42 });
        expect(stamped.usd).toBe(0.42);
    });

    test("seeding prefers the stamped usd over catalog re-pricing", () => {
        const t = new CostTracker();
        // Billed at $5 when it ran, by a model this machine's catalog doesn't
        // know — the stamp must win (re-pricing would zero it: the old bug).
        t.seedFromEntries("xai/grok-build-0.1", [
            { usage: { ...usage(100, 20), usd: 5 }, model: "gone/removed-model" },
        ]);
        expect(t.sessionBreakdown().usd).toBe(5);
    });

    test("unstamped legacy entries still price via the catalog", () => {
        const t = new CostTracker();
        t.seedFromEntries("xai/grok-build-0.1", [usage(1_000_000, 0)]);
        expect(t.sessionBreakdown().usd).toBeCloseTo(1, 6);
    });

    test("sumUsage sums usd and the split", () => {
        const a = stampUsageCost("xai/grok-build-0.1", usage(1_000_000, 0));
        const b = stampUsageCost("xai/grok-build-0.1", usage(0, 500_000));
        const s = sumUsage(a, b);
        expect(s.usd).toBeCloseTo(2, 6);
        expect(s.usdDetails?.input).toBeCloseTo(1, 6);
        expect(s.usdDetails?.output).toBeCloseTo(1, 6);
    });
});

describe("stepMessagesToEntries usage stamping", () => {
    // Resume seeding sums every usage-bearing assistant entry, so a step's
    // usage must land on exactly one message even if the SDK emits several.
    test("stamps a step's usage on only the first assistant message", () => {
        const step = [
            { role: "assistant", content: [{ type: "text", text: "part 1" }] },
            { role: "assistant", content: [{ type: "text", text: "part 2" }] },
        ];
        const out = stepMessagesToEntries(step, usage(100, 10));
        expect(out).toHaveLength(2);
        expect(out[0].usage).toEqual(usage(100, 10));
        expect(out[1].usage).toBeUndefined();
    });

    test("a task-only step still lands its usage on an empty assistant entry", () => {
        const step = [
            {
                role: "assistant",
                content: [{ type: "tool-call", toolName: "task", toolCallId: "t1", input: {} }],
            },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "done" }] },
        ];
        const out = stepMessagesToEntries(step, usage(100, 10));
        expect(out).toHaveLength(1);
        expect(out[0].role).toBe("assistant");
        expect(out[0].content).toEqual([]);
        expect(out[0].usage).toEqual(usage(100, 10));
    });

    test("no usage-only entry is emitted when the step has no usage", () => {
        const step = [
            {
                role: "assistant",
                content: [{ type: "tool-call", toolName: "task", toolCallId: "t1", input: {} }],
            },
        ];
        expect(stepMessagesToEntries(step, undefined)).toHaveLength(0);
    });
});
