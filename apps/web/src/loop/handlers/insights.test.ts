import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { LoopHost } from "../transport.ts";
import { readSessionInsights } from "./insights.ts";

const hostAnswering = (answers: Record<string, unknown>) => {
  const asked: { method: string; params: unknown }[] = [];
  const host = {
    id: "host",
    call: async (method: string, params: unknown) => {
      asked.push({ method, params });
      if (!(method in answers)) throw new Error("Method not found");
      return answers[method];
    },
  } as unknown as LoopHost;
  return { host, asked };
};

describe("session.insights", () => {
  it("reads /context, /cost and /steak for the thread's session in one go", async () => {
    const { host, asked } = hostAnswering({
      "context.report": {
        modelId: "claude-sonnet",
        contextWindow: 200_000,
        autoCompactThreshold: 0.8,
        totalTokens: 50_000,
        freeTokens: 150_000,
        categories: [{ key: "messages", label: "Messages", tokens: 40_000 }],
        skills: [],
        toolCount: 3,
        mcpToolCount: 0,
      },
      "cost.session": { inputTokens: 900, outputTokens: 100, cachedInputTokens: 500, usd: 0.25 },
      "cost.stats": {
        lifetimeUsd: 40,
        todayUsd: 1,
        last7Usd: 5,
        monthUsd: 20,
        byProvider: {},
        cwdUsd: 0,
      },
      "usage.steak": {
        totalTokens: 1_400_000_000,
        cells: [],
        stats: {
          currentStreak: 4,
          longestStreak: 9,
          activeDays: 120,
          busiestDay: "2026-03-14",
          busiestDayTokens: 9_000_000,
        },
      },
    });
    const insights = await Effect.runPromise(readSessionInsights({ threadId: "s-1" }, host));
    expect(asked.filter((call) => call.method.startsWith("co")).map((call) => call.params)).toEqual(
      [{ sessionId: "s-1" }, { sessionId: "s-1" }, {}],
    );
    expect(insights.context?.categories).toEqual([
      { key: "messages", label: "Messages", tokens: 40_000 },
    ]);
    expect(insights.cost?.usd).toBe(0.25);
    expect(insights.spend).toEqual({ todayUsd: 1, last7Usd: 5, monthUsd: 20, lifetimeUsd: 40 });
    expect(insights.usage?.totalTokens).toBe(1_400_000_000);
  });

  it("answers what it can when the host cannot tell the rest", async () => {
    const { host } = hostAnswering({
      "cost.session": { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0 },
    });
    const insights = await Effect.runPromise(readSessionInsights({ threadId: "draft" }, host));
    // Zero spend is "no turn yet", not "free".
    expect(insights).toEqual({ context: null, cost: null, spend: null, usage: null });
  });
});
