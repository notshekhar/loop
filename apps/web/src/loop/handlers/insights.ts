/**
 * `session.insights`: the terminal's `/context`, `/cost` and `/steak` for one
 * thread, read from the thread's own host.
 *
 * The desktop calls those loop methods directly (../insights.ts); the phone
 * only reaches a host through the RPC group, so this is that same read as one
 * request. Every part is computed loop-side and passed through narrowed, and
 * each comes back null on its own when that loop cannot answer it — an older
 * loop, a draft with no session yet — rather than failing the whole read.
 */
import type { SessionInsightsResult } from "@loop/contracts";
import * as Effect from "effect/Effect";

import type { LoopHost } from "../transport.ts";
import { loopSessionIdFor } from "./dispatch.ts";

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function contextOf(report: unknown): SessionInsightsResult["context"] {
  if (!isRecord(report) || !Array.isArray(report.categories)) return null;
  return {
    modelId: typeof report.modelId === "string" ? report.modelId : "",
    contextWindow: num(report.contextWindow),
    autoCompactThreshold: num(report.autoCompactThreshold),
    totalTokens: num(report.totalTokens),
    freeTokens: num(report.freeTokens),
    categories: report.categories.filter(isRecord).map((category) => ({
      key: String(category.key ?? category.label ?? ""),
      label: String(category.label ?? category.key ?? ""),
      tokens: num(category.tokens),
    })),
  };
}

function costOf(cost: unknown): SessionInsightsResult["cost"] {
  if (!isRecord(cost) || typeof cost.usd !== "number") return null;
  const breakdown = {
    inputTokens: num(cost.inputTokens),
    outputTokens: num(cost.outputTokens),
    cachedInputTokens: num(cost.cachedInputTokens),
    usd: num(cost.usd),
    ...(cost.estimated === true ? { estimated: true } : {}),
  };
  // All zeros means "no turn here yet", not "this session was free".
  const empty =
    breakdown.usd === 0 &&
    breakdown.inputTokens === 0 &&
    breakdown.outputTokens === 0 &&
    breakdown.cachedInputTokens === 0;
  return empty ? null : breakdown;
}

function spendOf(stats: unknown): SessionInsightsResult["spend"] {
  if (!isRecord(stats) || typeof stats.lifetimeUsd !== "number") return null;
  return {
    todayUsd: num(stats.todayUsd),
    last7Usd: num(stats.last7Usd),
    monthUsd: num(stats.monthUsd),
    lifetimeUsd: num(stats.lifetimeUsd),
  };
}

function usageOf(grid: unknown): SessionInsightsResult["usage"] {
  if (!isRecord(grid) || !isRecord(grid.stats)) return null;
  const stats = grid.stats;
  return {
    totalTokens: num(grid.totalTokens),
    currentStreak: num(stats.currentStreak),
    longestStreak: num(stats.longestStreak),
    activeDays: num(stats.activeDays),
    busiestDay: typeof stats.busiestDay === "string" ? stats.busiestDay : "",
    busiestDayTokens: num(stats.busiestDayTokens),
  };
}

export function readSessionInsights(
  input: { readonly threadId: string },
  host: LoopHost,
): Effect.Effect<SessionInsightsResult> {
  return Effect.promise(async () => {
    const sessionId = loopSessionIdFor(input.threadId);
    const ask = (method: string, params: Fields) =>
      host.call<unknown>(method, params).catch(() => null);
    const [context, cost, stats, steak] = await Promise.all([
      ask("context.report", { sessionId }),
      ask("cost.session", { sessionId }),
      ask("cost.stats", {}),
      ask("usage.steak", {}),
    ]);
    return {
      context: contextOf(context),
      cost: costOf(cost),
      spend: spendOf(stats),
      usage: usageOf(steak),
    };
  });
}
