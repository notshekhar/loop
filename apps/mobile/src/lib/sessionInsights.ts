/**
 * The numbers on the thread's Context & usage sheet, worked out the way the
 * terminal's `/context`, `/cost` and `/steak` print them. Tokens go through
 * loop's one formatter, so the phone reads 1.2B where the terminal does.
 */
import { formatTokens } from "@loop/format";

export { formatTokens };

/** How full the context is, 0–100, or null when the window is unknown. */
export function contextPercent(used: number, window: number): number | null {
  if (!(window > 0)) return null;
  return Math.min(100, Math.max(0, (used / window) * 100));
}

/** `23%`, with a decimal only below 1% so a fresh session doesn't read 0%. */
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/** Dollars at a readable precision: cents above a dollar, more below. */
export function formatUsd(usd: number, estimated = false): string {
  const prefix = estimated ? "~" : "";
  if (!Number.isFinite(usd) || usd <= 0) return `${prefix}$0.00`;
  if (usd >= 1) return `${prefix}$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `${prefix}$${usd.toFixed(3)}`;
  return `${prefix}$${usd.toFixed(4)}`;
}

export function formatDays(count: number): string {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

/** `2026-03-14` → `Mar 14, 2026` in the phone's locale. */
export function formatDay(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  if (!year) return key;
  return new Date(year, (month || 1) - 1, day || 1).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
