/**
 * The way-out sweep, against real processes: which of them are loop's to stop
 * is decided by the OS's process table, so a mocked one would only prove the
 * mock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { attachedDescendants, snapshotOwnProcesses, stopProcesses } from "../src/tools/utils/own-processes";

const started: ChildProcess[] = [];
const extraPids: number[] = [];

afterEach(() => {
    for (const c of started.splice(0)) c.kill("SIGKILL");
    for (const pid of extraPids.splice(0)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {}
    }
});

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

/** Resolves once `pred` holds, or fails the test after a while. */
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

/**
 * A server shaped like an `npx` wrapper: a parent that starts a worker of its
 * own and prints the worker's pid. The worker ignores SIGTERM, as plenty do.
 */
async function startWrapper(tag: string): Promise<{ wrapper: ChildProcess; worker: number }> {
    const script = `const c = require("child_process").spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done; # ${tag}"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1e9);`;
    const wrapper = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    started.push(wrapper);
    const worker = await new Promise<number>((resolve) => wrapper.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
    extraPids.push(worker);
    return { wrapper, worker };
}

describe("attachedDescendants", () => {
    test("walks the tree but leaves a detached subtree alone", () => {
        const table = [
            { pid: 10, ppid: 1, pgid: 10, command: "loop" },
            { pid: 11, ppid: 10, pgid: 10, command: "mcp" },
            { pid: 12, ppid: 11, pgid: 10, command: "mcp worker" },
            { pid: 13, ppid: 10, pgid: 13, command: "gateway daemon" },
            { pid: 14, ppid: 13, pgid: 13, command: "gateway child" },
            { pid: 15, ppid: 1, pgid: 10, command: "not ours" },
        ];
        expect(attachedDescendants(table, 10).map((p) => p.pid)).toEqual([11, 12]);
    });

    test("an unknown root has no descendants", () => {
        expect(attachedDescendants([], 10)).toEqual([]);
    });
});

describe("stopping what loop started", () => {
    test("a server's own worker is stopped with it, even one that ignores SIGTERM", async () => {
        const { wrapper, worker } = await startWrapper("sweep-1");
        const snapshot = snapshotOwnProcesses();
        expect(snapshot.map((p) => p.pid)).toEqual(expect.arrayContaining([wrapper.pid!, worker]));

        // What the MCP SDK does on close: the wrapper alone.
        wrapper.kill("SIGTERM");
        await until(() => wrapper.exitCode !== null || wrapper.signalCode !== null);
        expect(alive(worker)).toBe(true);

        expect(stopProcesses(snapshot.filter((p) => p.pid === worker))).toBe(1);
        await until(() => !alive(worker));
    });

    test("a detached child is not loop's to stop", async () => {
        const daemon = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
        started.push(daemon);
        await until(() => daemon.pid !== undefined);
        expect(snapshotOwnProcesses().some((p) => p.pid === daemon.pid)).toBe(false);
    });

    test("a pid that is now a different program is left alone", async () => {
        const child = spawn("sleep", ["30"], { stdio: "ignore" });
        started.push(child);
        const [row] = snapshotOwnProcesses().filter((p) => p.pid === child.pid);
        expect(row).toBeDefined();
        expect(stopProcesses([{ ...row!, command: "something else" }])).toBe(0);
        expect(alive(child.pid!)).toBe(true);
    });
});
