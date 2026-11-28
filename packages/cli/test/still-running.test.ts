/**
 * What quitting says it will stop, and how it stops running turns.
 */
import { describe, expect, test } from "bun:test";
import { describeStillRunning, interruptRunningTurns } from "../src/interactive/still-running";
import type { SessionSlot, SlotManager } from "../src/interactive/slots";

describe("describeStillRunning", () => {
    test("nothing running says nothing", () => {
        expect(describeStillRunning({ shells: 0, sessions: 0, threads: 0 })).toBe("");
    });

    test("names each kind, joined as a sentence", () => {
        expect(describeStillRunning({ shells: 1, sessions: 0, threads: 0 })).toBe("1 background shell");
        expect(describeStillRunning({ shells: 2, sessions: 1, threads: 0 })).toBe(
            "2 background shells and 1 running session",
        );
        expect(describeStillRunning({ shells: 2, sessions: 3, threads: 1 })).toBe(
            "2 background shells, 1 team thread and 3 running sessions",
        );
    });
});

/** A slot whose turn ends `settleMs` after it is aborted, as a real turn's finally does. */
function fakeSlot(busy: boolean, settleMs: number, remote = false): SessionSlot {
    const slot = { busy, queue: ["queued"], abort: new AbortController(), session: null, remote: remote || undefined };
    slot.abort.signal.addEventListener("abort", () => setTimeout(() => (slot.busy = false), settleMs));
    return slot as unknown as SessionSlot;
}

const slotsOf = (list: SessionSlot[]) => ({ all: () => list }) as unknown as SlotManager;

describe("interruptRunningTurns", () => {
    test("aborts every local busy turn, drops what queued behind it, and waits for it to settle", async () => {
        const busy = fakeSlot(true, 50);
        const idle = fakeSlot(false, 0);
        const remote = fakeSlot(true, 0, true);
        const { count, settled } = interruptRunningTurns(slotsOf([busy, idle, remote]));
        expect(count).toBe(1);
        expect(busy.abort.signal.aborted).toBe(true);
        expect(busy.queue).toEqual([]);
        // A remote turn runs on its own machine and is not ours to stop.
        expect(remote.abort.signal.aborted).toBe(false);
        expect(idle.abort.signal.aborted).toBe(false);
        await settled;
        expect(busy.busy).toBe(false);
    });

    test("a turn that never settles does not hold the exit forever", async () => {
        const stuck = fakeSlot(true, 60_000);
        const started = Date.now();
        await interruptRunningTurns(slotsOf([stuck])).settled;
        expect(Date.now() - started).toBeLessThan(2_500);
    });
});
