/**
 * Usage — the GUI form of the terminal's `/cost` and `/steak`.
 *
 * Both are loop's own concepts and upstream has no counterpart, so this route
 * is loop's. Everything is computed loop-side: `cost.stats` reads the ledger
 * (today / 7d / month / lifetime, split by provider) and `usage.steak` lays
 * the heatmap out with `buildSteakGrid`, the same function the CLI renders —
 * so the terminal and the app can never disagree about what a streak is or
 * which quartile a day falls into.
 *
 * The one thing done here rather than loop-side is colour, which is exactly
 * how core is arranged: `steak.ts` is pure layout and says so, because the CLI
 * paints its cells with chalk and a browser cannot.
 */
import { CoinsIcon, FlameIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatTokens } from "@loop/format";

import { cn } from "../../lib/utils";
import {
  readCostStats,
  readSteak,
  type CostStats,
  type SteakGrid,
} from "../../loop/insights";
import { providerPresentation } from "../../loop/providers";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";

/** Spend, at a precision that does not round a real session down to zero. */
function usd(amount: number): string {
  if (!Number.isFinite(amount)) return "$0.00";
  return `$${amount < 1 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

const tokens = formatTokens;

/**
 * Cell shading for an intensity level.
 *
 * `-1` is outside the range and must be invisible rather than "no usage" —
 * blanking the leading days of the first week is what makes the grid line up
 * with a calendar at all.
 */
const LEVEL_CLASS: Readonly<Record<number, string>> = {
  [-1]: "bg-transparent",
  0: "bg-muted",
  1: "bg-success/25",
  2: "bg-success/45",
  3: "bg-success/70",
  4: "bg-success",
};

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

/** `2026-08-08` + n days, as a local date — the grid's own day arithmetic. */
function dayAfter(startDay: string, days: number): string {
  const [year, month, day] = startDay.split("-").map(Number);
  if (!year || !month || !day) return "";
  const date = new Date(year, month - 1, day + days);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function SteakHeatmap({ grid }: { grid: SteakGrid }) {
  return (
    <div className="overflow-x-auto px-3 pb-2 sm:px-4">
      <div className="inline-flex flex-col gap-1">
        <div className="flex gap-[3px] ps-8">
          {grid.monthLabels.map((label, week) => (
            // Columns are weeks and have no identity beyond position.
            // eslint-disable-next-line react/no-array-index-key
            <span
              className="w-[11px] shrink-0 text-[10px] text-muted-foreground/60"
              key={week}
            >
              {label}
            </span>
          ))}
        </div>
        <div className="flex gap-[3px]">
          <div className="flex w-8 shrink-0 flex-col gap-[3px]">
            {WEEKDAY_LABELS.map((label, weekday) => (
              // eslint-disable-next-line react/no-array-index-key
              <span
                className="h-[11px] text-[10px] text-muted-foreground/60 leading-[11px]"
                key={weekday}
              >
                {label}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-[3px]">
            {grid.cells.map((row, weekday) => (
              // eslint-disable-next-line react/no-array-index-key
              <div className="flex gap-[3px]" key={weekday}>
                {row.map((level, week) => {
                  const dayTokens = grid.tokens[weekday]?.[week] ?? -1;
                  const date = dayAfter(grid.startDay, week * 7 + weekday);
                  return (
                    // eslint-disable-next-line react/no-array-index-key
                    <div
                      className={cn(
                        "size-[11px] shrink-0 rounded-[2px]",
                        LEVEL_CLASS[level] ?? "bg-muted",
                      )}
                      key={week}
                      title={
                        level < 0
                          ? undefined
                          : `${date}: ${dayTokens > 0 ? `${tokens(dayTokens)} tokens` : "no usage"}`
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5 ps-8 pt-1 text-[10px] text-muted-foreground/60">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              className={cn("size-[11px] rounded-[2px]", LEVEL_CLASS[level])}
              key={level}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/50 px-3 py-2">
      <p className="text-[11px] text-muted-foreground/70 uppercase tracking-wide">{label}</p>
      <p className="mt-0.5 font-medium text-base tabular-nums">{value}</p>
    </div>
  );
}

function Note({ children }: { children: string }) {
  return <p className="px-3 py-3 text-[13px] text-muted-foreground/80 sm:px-4">{children}</p>;
}

export function LoopUsageSettings() {
  const [stats, setStats] = useState<CostStats | null>(null);
  const [grid, setGrid] = useState<SteakGrid | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([readCostStats(), readSteak()]).then(([nextStats, nextGrid]) => {
      if (cancelled) return;
      setStats(nextStats);
      setGrid(nextGrid);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Biggest spender first: with a dozen providers configured, alphabetical
  // order buries the one the bill actually came from.
  const providers = useMemo(
    () =>
      Object.entries(stats?.byProvider ?? {})
        .filter(([, amount]) => amount > 0)
        .toSorted(([, left], [, right]) => right - left),
    [stats],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        icon={<CoinsIcon className="size-4 text-muted-foreground/70" />}
        id="usage-cost"
        title="Cost"
      >
        {loading ? (
          <Note>Reading loop&apos;s ledger…</Note>
        ) : stats ? (
          <>
            <div className="grid grid-cols-2 gap-2 px-3 sm:grid-cols-4 sm:px-4">
              <Stat label="Today" value={usd(stats.todayUsd)} />
              <Stat label="Last 7 days" value={usd(stats.last7Usd)} />
              <Stat label="This month" value={usd(stats.monthUsd)} />
              <Stat label="Lifetime" value={usd(stats.lifetimeUsd)} />
            </div>
            {providers.length > 0 ? (
              <ul className="mt-2 space-y-0.5 px-3 sm:px-4">
                {providers.map(([provider, amount]) => (
                  <li className="flex justify-between gap-3 text-[13px]" key={provider}>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {providerPresentation(provider).label}
                    </span>
                    <span className="shrink-0 tabular-nums">{usd(amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Note>Nothing billed yet.</Note>
            )}
          </>
        ) : (
          <Note>This loop does not report cost.</Note>
        )}
      </SettingsSection>

      <SettingsSection
        icon={<FlameIcon className="size-4 text-muted-foreground/70" />}
        id="usage-steak"
        title="Steak"
      >
        {loading ? (
          <Note>Building the heatmap…</Note>
        ) : grid ? (
          <>
            <div className="grid grid-cols-2 gap-2 px-3 sm:grid-cols-4 sm:px-4">
              <Stat label="Current streak" value={`${grid.stats.currentStreak}d`} />
              <Stat label="Longest streak" value={`${grid.stats.longestStreak}d`} />
              <Stat label="Active days" value={String(grid.stats.activeDays)} />
              <Stat label="Tokens" value={tokens(grid.totalTokens)} />
            </div>
            <SteakHeatmap grid={grid} />
            {grid.stats.busiestDay ? (
              <Note>
                {`Busiest day: ${grid.stats.busiestDay} (${tokens(grid.stats.busiestDayTokens)} tokens).`}
              </Note>
            ) : (
              <Note>No usage recorded in the last year.</Note>
            )}
          </>
        ) : (
          <Note>This loop does not report usage history.</Note>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
