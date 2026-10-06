/**
 * The state of a live session — one that is loaded in this process — as a
 * roster shows it. Shared vocabulary for every surface that lists running
 * sessions side by side (the TUI's switcher and dashboard, desktop threads),
 * so "needs you" means the same thing everywhere.
 *
 *   needs-input  an agent-driven prompt (ask, approval) is waiting on the user
 *   working      a turn, compaction or goal step is running
 *   done         finished since the user last looked at it
 *   failed       ended on an error since the user last looked at it
 *   idle         nothing running, nothing unseen
 */
export type LiveStatus = "needs-input" | "working" | "done" | "failed" | "idle";

/** Roster order: what needs you first, then what is moving, then the rest. */
export const LIVE_STATUS_ORDER: readonly LiveStatus[] = ["needs-input", "working", "done", "failed", "idle"];

export interface LiveStatusCounts {
    "needs-input": number;
    working: number;
    done: number;
    failed: number;
    idle: number;
}

export function countLiveStatuses(statuses: Iterable<LiveStatus>): LiveStatusCounts {
    const counts: LiveStatusCounts = { "needs-input": 0, working: 0, done: 0, failed: 0, idle: 0 };
    for (const s of statuses) counts[s]++;
    return counts;
}

/**
 * Sort rows for a roster: by status (LIVE_STATUS_ORDER), then most recently
 * active first. Stable for equal keys, so a row does not jump around while
 * nothing about it changed.
 */
export function sortLiveRows<T extends { status: LiveStatus; lastActivityAt: number }>(rows: readonly T[]): T[] {
    const rank = (s: LiveStatus) => LIVE_STATUS_ORDER.indexOf(s);
    return [...rows].sort((a, b) => rank(a.status) - rank(b.status) || b.lastActivityAt - a.lastActivityAt);
}
