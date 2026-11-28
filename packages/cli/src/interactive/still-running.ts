/**
 * What quitting would stop, and stopping it.
 *
 * Every way out (Ctrl+C twice, Ctrl+D, /exit) asks the same question first —
 * is anything still working that dies with this process? — so the warning
 * says the same thing whichever key you pressed. And every way out stops
 * those turns the same way: aborted, so each saves where it stopped and a
 * team thread settles as cancelled, instead of being cut off mid-write by
 * process.exit and read as "running" for minutes by whoever looks next.
 */
import { runningShellTotal, teamOf } from "@notshekhar/loop-core";
import type { SessionSlot, SlotManager } from "./slots";

export interface StillRunning {
    readonly shells: number;
    /** Busy sessions that are not team threads. */
    readonly sessions: number;
    /** Busy team threads. */
    readonly threads: number;
}

/** How long aborted turns get to save before loop exits regardless. */
const TURN_SETTLE_MS = 1_500;
const POLL_MS = 25;

/** Turns this process runs; a remote slot's turn runs on its own host and keeps going. */
function busyLocal(slots: SlotManager): SessionSlot[] {
    return slots.all().filter((s) => s.busy && !s.remote);
}

export function stillRunning(slots: SlotManager): StillRunning {
    const busy = busyLocal(slots);
    const threads = busy.filter((s) => s.session && teamOf(s.session.id)?.role === "member").length;
    return { shells: runningShellTotal(), sessions: busy.length - threads, threads };
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "2 background shells, 1 thread and 1 session", or "" when nothing is running. */
export function describeStillRunning(r: StillRunning): string {
    const parts = [
        r.shells > 0 ? count(r.shells, "background shell") : "",
        r.threads > 0 ? count(r.threads, "team thread") : "",
        r.sessions > 0 ? count(r.sessions, "running session") : "",
    ].filter(Boolean);
    if (parts.length <= 1) return parts[0] ?? "";
    return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Abort every turn this process is running, and resolve once they have all
 * settled (saved their partial step, marked their thread) or the grace runs
 * out. Queued input is dropped first, or a settling turn would start the next.
 */
export function interruptRunningTurns(slots: SlotManager): { count: number; settled: Promise<void> } {
    const busy = busyLocal(slots);
    for (const slot of busy) {
        slot.queue.length = 0;
        slot.abort.abort();
    }
    const deadline = Date.now() + TURN_SETTLE_MS;
    const settled = new Promise<void>((resolve) => {
        const check = (): void => {
            if (busy.every((s) => !s.busy) || Date.now() >= deadline) resolve();
            else setTimeout(check, POLL_MS);
        };
        check();
    });
    return { count: busy.length, settled };
}
