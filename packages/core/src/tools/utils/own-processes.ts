/**
 * The processes this loop started, so it can take them down on its way out.
 *
 * Every server loop runs — an MCP server, a language server, a native agent —
 * is stopped on the way out, but only that one process. Whatever IT started
 * (the node behind an `npx` wrapper, a language server's worker) is handed to
 * pid 1 the moment its parent dies, and runs on with nobody left who knows it
 * exists. So the way out reads the process table while the tree is still
 * whole, and stops every descendant still in loop's own process group.
 *
 * The process group is the line between "ours" and "meant to outlive us":
 * everything spawned to survive (gateways, `/background` runs, an editor, the
 * browser, a chime) is spawned detached into a group of its own, and that
 * whole subtree is left alone. Background shells are detached too — the shell
 * registry stops those itself.
 */
import { execFileSync } from "node:child_process";

export interface OwnProcess {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    readonly command: string;
}

/** Long enough for a server to exit on SIGTERM, short enough that nobody waits on the prompt. */
export const STOP_GRACE_MS = 300;
const POLL_MS = 20;
/** `ps` prints the whole table; a busy machine is a few hundred KB of it. */
const PS_MAX_BUFFER = 16 * 1024 * 1024;

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;

interface TableRow extends OwnProcess {
    readonly zombie: boolean;
}

function readTable(pids?: readonly number[]): TableRow[] {
    if (process.platform === "win32") return [];
    const select = pids ? ["-p", pids.join(",")] : ["-A"];
    try {
        const out = execFileSync("ps", [...select, "-o", "pid=,ppid=,pgid=,stat=,command="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: PS_MAX_BUFFER,
        });
        return parseRows(out);
    } catch {
        // No ps, or (with -p) none of the pids exist any more — ps exits 1.
        return [];
    }
}

function parseRows(text: string): TableRow[] {
    const rows: TableRow[] = [];
    for (const line of text.split("\n")) {
        const m = ROW.exec(line);
        if (!m) continue;
        rows.push({ pid: +m[1]!, ppid: +m[2]!, pgid: +m[3]!, zombie: m[4]!.startsWith("Z"), command: m[5]! });
    }
    return rows;
}

/** Descendants of `root` still in its process group; a detached child's subtree is not ours to stop. */
export function attachedDescendants(table: readonly OwnProcess[], root: number): OwnProcess[] {
    const group = table.find((p) => p.pid === root)?.pgid;
    if (group === undefined) return [];
    const children = new Map<number, OwnProcess[]>();
    for (const p of table) {
        const list = children.get(p.ppid) ?? [];
        list.push(p);
        children.set(p.ppid, list);
    }
    const out: OwnProcess[] = [];
    const queue = [root];
    while (queue.length > 0) {
        for (const child of children.get(queue.shift()!) ?? []) {
            if (child.pgid !== group || child.pid === root) continue;
            out.push(child);
            queue.push(child.pid);
        }
    }
    return out;
}

/** Every process this one started that is meant to die with it, as of now. */
export function snapshotOwnProcesses(): OwnProcess[] {
    return attachedDescendants(readTable(), process.pid);
}

/**
 * The snapshot's processes that are still running and still the same program.
 * A pid whose command changed belongs to someone else now. Zombies have
 * already exited — they only wait for their parent to reap them.
 */
function stillRunning(snapshot: readonly OwnProcess[]): OwnProcess[] {
    if (snapshot.length === 0) return [];
    const now = new Map(readTable(snapshot.map((p) => p.pid)).map((r) => [r.pid, r]));
    return snapshot.filter((p) => {
        const row = now.get(p.pid);
        return row !== undefined && !row.zombie && row.command === p.command;
    });
}

function signal(processes: readonly OwnProcess[], sig: NodeJS.Signals): void {
    for (const p of processes) {
        try {
            process.kill(p.pid, sig);
        } catch {
            // Gone already.
        }
    }
}

/** Synchronous, because the "exit" handler that also calls this cannot await. */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop what is left of a snapshot: SIGTERM, a short grace, then SIGKILL for
 * whatever ignored it. Returns how many were still running.
 */
export function stopProcesses(snapshot: readonly OwnProcess[], graceMs = STOP_GRACE_MS): number {
    const running = stillRunning(snapshot);
    if (running.length === 0) return 0;
    signal(running, "SIGTERM");
    const deadline = Date.now() + graceMs;
    let left = running;
    while (left.length > 0 && Date.now() < deadline) {
        sleepSync(POLL_MS);
        left = stillRunning(left);
    }
    signal(left, "SIGKILL");
    return running.length;
}

let sweepInstalled = false;

/**
 * Stop this loop's processes when it exits, however it exits — including the
 * TUI's SIGHUP path (a closed terminal tab), which goes straight to
 * process.exit. Called wherever a long-lived child is spawned, so every
 * surface that has one gets the sweep and none has to remember it.
 */
export function ensureOwnProcessSweep(): void {
    if (sweepInstalled) return;
    sweepInstalled = true;
    process.once("exit", () => {
        stopProcesses(snapshotOwnProcesses());
    });
}
