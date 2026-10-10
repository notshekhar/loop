/**
 * What this conversation is costing, and how full its context is.
 *
 * The terminal has three commands for this — `/context`, `/cost`, `/compact` —
 * and the app had none, so a session's context filling up was invisible until
 * loop compacted on its own and the agent appeared to forget things. They live
 * in one control because they are one question ("how is this session doing?")
 * and because the answer to the first is what makes the third worth pressing.
 *
 * Every number comes from loop: `context.report` runs the same assembly
 * `runTurn` does, and `cost.session` is seeded from loop's ledger, so this
 * cannot disagree with what the terminal says about the same session.
 *
 * The trigger is a ring, not a percentage — the exact number is rarely the
 * point, "am I near the compaction line" always is. It turns amber at loop's
 * own `autoCompactThreshold`, so the warning appears exactly when loop is
 * about to act.
 */
import { GaugeIcon, Loader2Icon, ScissorsIcon } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { formatTokens } from "@loop/format";

import { cn } from "../../lib/utils";
import {
  compactSession,
  readContextReport,
  readSessionCost,
  type ContextReport,
  type SessionCost,
} from "../../loop/insights";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** `128400` → `128k`, `940` → `940`, on through M, B and T. */
export { formatTokens };

/**
 * Spend, at a readable precision.
 *
 * Fractions of a cent matter here — a single turn is routinely $0.004 — so
 * small amounts keep four decimals rather than rounding to `$0.00`, which
 * would report every short session as free.
 */
export function formatUsd(usd: number, estimated?: boolean): string {
  if (!Number.isFinite(usd)) return "$0.00";
  const prefix = estimated ? "~" : "";
  return `${prefix}$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** How full, as a fraction, or null when loop does not know the window. */
export function contextFraction(report: ContextReport | null): number | null {
  if (!report || report.contextWindow <= 0) return null;
  return Math.min(1, report.totalTokens / report.contextWindow);
}

/** The ring around the trigger: how full the context is, at a glance. */
function ContextRing({ fraction, warn }: { fraction: number | null; warn: boolean }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const filled = fraction === null ? 0 : circumference * fraction;
  return (
    <svg aria-hidden className="size-4 shrink-0 -rotate-90" viewBox="0 0 16 16">
      <circle
        className="stroke-border"
        cx="8"
        cy="8"
        fill="none"
        r={radius}
        strokeWidth="2"
      />
      {fraction === null ? null : (
        <circle
          className={cn(warn ? "stroke-warning" : "stroke-muted-foreground/70")}
          cx="8"
          cy="8"
          fill="none"
          r={radius}
          strokeDasharray={`${filled} ${circumference}`}
          strokeLinecap="round"
          strokeWidth="2"
        />
      )}
    </svg>
  );
}

function CategoryBar({ report }: { report: ContextReport }) {
  const window = report.contextWindow;
  // Only the categories that would draw a visible sliver; the rest are in the
  // list below anyway, and a stack of zero-width bars is just noise.
  const shown = report.categories.filter((category) => category.tokens > 0);
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
      {shown.map((category, index) => (
        <div
          className={cn(
            index % 2 === 0 ? "bg-muted-foreground/60" : "bg-muted-foreground/35",
          )}
          key={category.key}
          style={{ width: `${Math.max(0.5, (category.tokens / window) * 100)}%` }}
          title={`${category.label}: ${formatTokens(category.tokens)}`}
        />
      ))}
    </div>
  );
}

export interface SessionInsightsProps {
  /** loop's session id. Absent on a draft — nothing has been sent yet, so
   * there is no context and no spend to report. */
  readonly sessionId: string | null;
  readonly cwd: string | null;
  /** Suppresses the refresh while a turn is running: the numbers move
   * constantly mid-turn and re-reading them per frame is pointless. */
  readonly running: boolean;
}

export const SessionInsights = memo(function SessionInsights({
  sessionId,
  cwd,
  running,
}: SessionInsightsProps) {
  const [report, setReport] = useState<ContextReport | null>(null);
  const [cost, setCost] = useState<SessionCost | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setReport(null);
      setCost(null);
      return;
    }
    const [nextReport, nextCost] = await Promise.all([
      readContextReport({ sessionId, ...(cwd ? { cwd } : {}) }),
      readSessionCost(sessionId, cwd ?? undefined),
    ]);
    setReport(nextReport);
    setCost(nextCost);
  }, [cwd, sessionId]);

  // Re-read when the turn ends: that is when the totals actually changed, and
  // it is the only moment they change without the user doing anything.
  useEffect(() => {
    if (running) return;
    void refresh();
  }, [refresh, running]);

  const onCompact = useCallback(async () => {
    if (!sessionId) return;
    setCompacting(true);
    setError(null);
    try {
      const result = await compactSession(sessionId, cwd ?? undefined);
      // loop's own answer for "there was nothing above the cut point". Saying
      // so beats a silent no-op that looks like a broken button.
      if (result.summary === "") setError("Nothing to compact yet.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCompacting(false);
    }
  }, [cwd, refresh, sessionId]);

  // Nothing to say about a draft, so the control is not there — an empty
  // gauge on a thread with no messages is a question nobody asked.
  if (!sessionId) return null;

  const fraction = contextFraction(report);
  const warn = fraction !== null && report !== null && fraction >= report.autoCompactThreshold;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            aria-label="Session usage and cost"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          />
        }
      >
        {report ? (
          <ContextRing fraction={fraction} warn={warn} />
        ) : (
          <GaugeIcon aria-hidden className="size-4 shrink-0" />
        )}
        {cost ? (
          <span className="tabular-nums">{formatUsd(cost.usd, cost.estimated)}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80 p-3" side="bottom" sideOffset={6}>
        {report ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-medium text-sm">Context</p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {report.contextWindow > 0
                  ? `${formatTokens(report.totalTokens)} / ${formatTokens(report.contextWindow)}`
                  : formatTokens(report.totalTokens)}
              </p>
            </div>
            {report.contextWindow > 0 ? (
              <div className="mt-2">
                <CategoryBar report={report} />
                <p className={cn("mt-1 text-xs", warn ? "text-warning" : "text-muted-foreground")}>
                  {fraction === null ? null : `${Math.round(fraction * 100)}% used`}
                  {report.autoCompactThreshold > 0
                    ? ` · loop compacts at ${Math.round(report.autoCompactThreshold * 100)}%`
                    : null}
                </p>
              </div>
            ) : (
              // Model not in loop's catalog: the totals are still real, the
              // window is not known, so no bar is drawn rather than a made-up
              // one.
              <p className="mt-1 text-muted-foreground text-xs">
                loop does not know {report.modelId}&apos;s context window.
              </p>
            )}

            <ul className="mt-3 space-y-0.5">
              {report.categories
                .filter((category) => category.tokens > 0)
                .map((category) => (
                  <li className="flex justify-between gap-2 text-xs" key={category.key}>
                    <span className="min-w-0 truncate text-muted-foreground">{category.label}</span>
                    <span className="shrink-0 text-muted-foreground/70 tabular-nums">
                      {formatTokens(category.tokens)}
                    </span>
                  </li>
                ))}
            </ul>
            <p className="mt-2 text-muted-foreground/60 text-xs">
              {report.toolCount} tool{report.toolCount === 1 ? "" : "s"}
              {report.mcpToolCount > 0 ? ` (${report.mcpToolCount} from MCP)` : ""}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-xs">
            This loop does not report a context breakdown.
          </p>
        )}

        {cost ? (
          <div className="mt-3 border-border/60 border-t pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-medium text-sm">Cost</p>
              <p className="text-sm tabular-nums">{formatUsd(cost.usd, cost.estimated)}</p>
            </div>
            <p className="mt-1 text-muted-foreground text-xs tabular-nums">
              {formatTokens(cost.inputTokens)} in · {formatTokens(cost.outputTokens)} out ·{" "}
              {formatTokens(cost.cachedInputTokens)} cached
            </p>
            {cost.estimated ? (
              <p className="mt-1 text-muted-foreground/60 text-xs">
                Includes an estimate for an interrupted turn.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 border-border/60 border-t pt-3">
          <Button
            className="w-full gap-2"
            disabled={compacting || running}
            onClick={() => void onCompact()}
            size="sm"
            type="button"
            variant="outline"
          >
            {compacting ? (
              <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <ScissorsIcon aria-hidden className="size-3.5" />
            )}
            {compacting ? "Compacting…" : "Compact context"}
          </Button>
          <p className="mt-1.5 text-muted-foreground/60 text-xs">
            {running
              ? "Not while a turn is running."
              : "Summarizes the older conversation and keeps the most recent part word for word."}
          </p>
          {error ? <p className="mt-1.5 text-destructive text-xs">{error}</p> : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
