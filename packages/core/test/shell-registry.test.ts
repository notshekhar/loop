/**
 * Background shell registry — driven against real spawned processes, because
 * every interesting behaviour here (exit codes, kill trees, output arriving
 * between reads) is the OS's, not ours. A mocked child would only prove the
 * mock works.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    MAX_READ_BYTES,
    adoptSharedShells,
    formatDuration,
    killAllBashChildren,
    killSessionShells,
    killShell,
    listShells,
    readShell,
    registerShell,
    resetShellRegistry,
    runningShellCount,
    takeShellNotices,
    type ShellInfo,
} from "../src/tools/utils/shell-registry";
import { formatShellNotices } from "../src/tools/shells";
import {
    KEPT_LOG_BYTES,
    LOG_RETENTION_MS,
    MAX_LOG_BYTES,
    pruneShellLogs,
    setShellLogRootForTests,
    shellLogRoot,
} from "../src/tools/utils/shell-logs";
import { useTempShellLogs } from "./helpers/temp-shell-logs";

useTempShellLogs();

const SESSION = "test-session";

function startIn(session: string | undefined, command: string): ShellInfo {
    const child = spawn("/bin/bash", ["-c", command], {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return registerShell({ sessionId: session, command, cwd: process.cwd(), child });
}

function start(command: string, session = SESSION): ShellInfo {
    return startIn(session, command);
}

/** A shell with no session yet (`/shells run` ahead of the first message), run to its end. */
async function finishedBeforeSession(command: string): Promise<ShellInfo> {
    const s = startIn(undefined, command);
    await until(
        () =>
            listShells(undefined).find((x) => x.id === s.id)?.status === "exited" &&
            readShell(undefined, s.id, { advance: false })?.text !== "",
        "the unsaved shell finished",
    );
    return s;
}

/** Poll until the shell leaves "running", or fail loudly. */
async function settled(id: string, session = SESSION, timeoutMs = 5000): Promise<ShellInfo> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = listShells(session).find((s) => s.id === id);
        if (found && found.status !== "running") return found;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${id} never settled`);
}

beforeEach(() => {
    resetShellRegistry();
});

afterEach(() => {
    for (const s of listShells(SESSION)) if (s.status === "running") killShell(SESSION, s.id);
    resetShellRegistry();
});

/** Poll until `check` holds, or fail loudly. */
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`never: ${what}`);
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("a shell that exits and leaves a process behind", () => {
    /** Exits at once; the printed pid outlives it. */
    async function leaveSleeper(session = SESSION): Promise<{ shell: ShellInfo; leftover: number }> {
        const shell = start("sleep 30 & echo $!; exit 0", session);
        await settled(shell.id, session);
        await until(() => readFileSync(shell.logPath, "utf8").trim() !== "", "the leftover pid in the log");
        return { shell, leftover: Number(readFileSync(shell.logPath, "utf8").trim()) };
    }

    test("what it prints later reaches the log, and the count matches the file", async () => {
        const s = start("echo early; (sleep 0.3; echo late) &");
        await settled(s.id);
        await until(() => listShells(SESSION)[0]!.bytes === "early\nlate\n".length, "the late line counted");
        expect(readFileSync(s.logPath, "utf8")).toBe("early\nlate\n");
        expect(statSync(s.logPath).size).toBe(listShells(SESSION)[0]!.bytes);
        expect(readShell(SESSION, s.id)?.text).toContain("late");
    });

    test("killAllBashChildren takes the leftover down too", async () => {
        const { leftover } = await leaveSleeper();
        expect(isAlive(leftover)).toBe(true);
        killAllBashChildren();
        await until(() => !isAlive(leftover), "the leftover killed");
    });

    test("killing the exited shell by id, or its session, does too", async () => {
        const byId = await leaveSleeper();
        killShell(SESSION, byId.shell.id);
        await until(() => !isAlive(byId.leftover), "the leftover killed by id");

        const bySession = await leaveSleeper("whole-session");
        expect(killSessionShells("whole-session")).toBe(0); // nothing was running…
        await until(() => !isAlive(bySession.leftover), "the leftover killed with its session"); // …but it goes
    });
});

describe("shells started before the session existed", () => {
    test("join the session, keeping their id, log and output", async () => {
        const s = await finishedBeforeSession("echo hello");
        adoptSharedShells(SESSION);
        expect(listShells(undefined)).toEqual([]);
        expect(listShells(SESSION).map((x) => x.id)).toEqual([s.id]);
        expect(readShell(SESSION, s.id)?.text).toContain("hello");
    });

    test("number after the session's own, and a later one never reuses their log", async () => {
        start("true");
        const early = await finishedBeforeSession("echo first");
        adoptSharedShells(SESSION);
        expect(listShells(SESSION).map((x) => x.id)).toEqual(["bash_1", "bash_2"]);
        const next = startIn(undefined, "true");
        expect(next.logPath).not.toBe(early.logPath);
        expect(readShell(SESSION, "bash_2")?.text).toContain("first");
    });
});

describe("logs on disk", () => {
    test("a log that reaches the cap keeps its newest output, and reads stay right", async () => {
        const size = MAX_LOG_BYTES + 1024 * 1024;
        const s = start(`head -c ${size} /dev/zero | tr '\\0' x; echo; echo the-end`);
        await settled(s.id, SESSION, 20_000);
        await until(() => listShells(SESSION)[0]!.bytes === size + "\nthe-end\n".length, "all output counted", 20_000);
        const disk = statSync(s.logPath).size;
        expect(disk).toBeLessThanOrEqual(MAX_LOG_BYTES);
        expect(disk).toBeGreaterThanOrEqual(KEPT_LOG_BYTES);

        const read = readShell(SESSION, s.id)!;
        expect(read.text.endsWith("the-end\n")).toBe(true);
        expect(read.text.length).toBe(MAX_READ_BYTES);
        expect(read.skippedBytes).toBe(size + "\nthe-end\n".length - MAX_READ_BYTES);
    }, 30_000);

    test("a shell with no log counts nothing, so no read points at bytes that are not there", async () => {
        setShellLogRootForTests("/dev/null/not-a-folder");
        const s = start("echo hi");
        await settled(s.id);
        await new Promise((r) => setTimeout(r, 100));
        const info = listShells(SESSION)[0]!;
        expect(info.logPath).toBe("");
        expect(info.bytes).toBe(0);
        expect(info.preview.join("")).toContain("hi");
    });

    test("old sessions' logs go, recent ones stay", () => {
        const dirFor = (name: string, ageMs: number) => {
            const dir = join(shellLogRoot(), name);
            mkdirSync(dir);
            writeFileSync(join(dir, "bash_1.log"), "x");
            const at = new Date(Date.now() - ageMs);
            utimesSync(join(dir, "bash_1.log"), at, at);
            utimesSync(dir, at, at);
            return dir;
        };
        const old = dirFor("old", LOG_RETENTION_MS + 60_000);
        const recent = dirFor("recent", LOG_RETENTION_MS - 60_000);
        pruneShellLogs();
        expect(existsSync(old)).toBe(false);
        expect(existsSync(recent)).toBe(true);
    });
});

describe("registry", () => {
    test("ids are per-session and sequential", () => {
        expect(start("true").id).toBe("bash_1");
        expect(start("true").id).toBe("bash_2");
        expect(start("true", "other").id).toBe("bash_1");
    });

    test("a finished shell reports its exit code", async () => {
        const s = start("exit 3");
        const done = await settled(s.id);
        expect(done.status).toBe("exited");
        expect(done.exitCode).toBe(3);
        expect(done.endedAt).not.toBeNull();
    });

    test("running shells are counted, finished ones are not", async () => {
        const s = start("sleep 30");
        expect(runningShellCount(SESSION)).toBe(1);
        killShell(SESSION, s.id);
        await settled(s.id);
        expect(runningShellCount(SESSION)).toBe(0);
    });

    test("kill stops the whole process tree", async () => {
        // The child spawns a grandchild; killing by pid alone would orphan it.
        const s = start("sleep 60 & sleep 60");
        const info = killShell(SESSION, s.id);
        expect(info).toBeDefined();
        const done = await settled(s.id);
        expect(done.status === "killed" || done.status === "exited").toBe(true);
    });
});

describe("reads", () => {
    test("output is returned once, not on every read", async () => {
        const s = start("echo first; echo second");
        await settled(s.id);
        const first = readShell(SESSION, s.id);
        expect(first?.text).toContain("first");
        expect(first?.text).toContain("second");
        // The cursor advanced: the same output must not come back again.
        const second = readShell(SESSION, s.id);
        expect(second?.text.trim()).toBe("");
    });

    test("advance:false leaves the output for the next reader", async () => {
        // /shells peeking must not consume what the agent has not read yet.
        const s = start("echo hello");
        await settled(s.id);
        expect(readShell(SESSION, s.id, { advance: false })?.text).toContain("hello");
        expect(readShell(SESSION, s.id)?.text).toContain("hello");
    });

    test("filter keeps matching lines and counts the rest", async () => {
        const s = start("echo alpha; echo BAD thing; echo beta");
        await settled(s.id);
        const r = readShell(SESSION, s.id, { filter: "BAD" });
        expect(r?.text).toContain("BAD thing");
        expect(r?.text).not.toContain("alpha");
        expect(r?.filteredOut).toBeGreaterThan(0);
    });

    test("an unparseable filter is ignored rather than fatal", async () => {
        const s = start("echo hello");
        await settled(s.id);
        const r = readShell(SESSION, s.id, { filter: "([" });
        expect(r?.text).toContain("hello");
    });

    test("reading an unknown shell returns undefined", () => {
        expect(readShell(SESSION, "bash_99")).toBeUndefined();
        expect(killShell(SESSION, "bash_99")).toBeUndefined();
    });
});

describe("exit notices", () => {
    test("an exit is reported exactly once", async () => {
        const s = start("exit 1");
        await settled(s.id);
        const first = takeShellNotices(SESSION);
        expect(first.map((n) => n.id)).toEqual([s.id]);
        // Taken means delivered: the model is not told twice about one exit.
        expect(takeShellNotices(SESSION)).toEqual([]);
    });

    test("a running shell produces no notice", () => {
        start("sleep 30");
        expect(takeShellNotices(SESSION)).toEqual([]);
    });
});

describe("formatDuration", () => {
    test("reads as elapsed time, not milliseconds", () => {
        expect(formatDuration(8_000)).toBe("8s");
        expect(formatDuration(134_000)).toBe("2m14s");
        expect(formatDuration(3_780_000)).toBe("1h03m");
    });
});

describe("exit notice text", () => {
    test("names the shell, what happened, and whether output is waiting", async () => {
        const s = start("echo left-behind; exit 2");
        const done = await settled(s.id);
        const text = formatShellNotices([done]);
        expect(text).toContain(s.id);
        expect(text).toContain("exited with code 2");
        expect(text).toContain("bytes unread");
        // Ephemeral by contract: it must look like a reminder, not a message
        // the user wrote — it rides one request and is never persisted.
        expect(text?.startsWith("<system-reminder>")).toBe(true);
    });

    test("nothing to report produces nothing at all", () => {
        expect(formatShellNotices([])).toBeNull();
    });
});

describe("process exit", () => {
    test("killAllBashChildren stops shells in every session, not just one", async () => {
        // The bug this covers is a surface (serve / rpc / print / desktop)
        // exiting with shells still running: the registry is in memory, so
        // nothing that comes later can list, read or kill them.
        const other = "test-session-two";
        const a = start("sleep 60");
        const b = start("sleep 60", other);

        const killed = killAllBashChildren();
        expect(killed).toBe(2);

        const doneA = await settled(a.id);
        const doneB = await settled(b.id, other);
        expect(doneA.status === "killed" || doneA.status === "exited").toBe(true);
        expect(doneB.status === "killed" || doneB.status === "exited").toBe(true);
        expect(runningShellCount(SESSION)).toBe(0);
        expect(runningShellCount(other)).toBe(0);
    });

    test("killing nothing is not an error", () => {
        expect(killAllBashChildren()).toBe(0);
    });
});
