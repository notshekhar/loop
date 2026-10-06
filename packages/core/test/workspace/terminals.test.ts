import { describe, expect, test } from "bun:test";
import { tmpdir, userInfo } from "node:os";

import { TerminalManager, type PtyProcess, type TerminalOutput } from "../../src/workspace/terminals";

/**
 * A PTY whose data and exit callbacks this test drives.
 *
 * A real one cannot be used here: node-pty spawns under Bun but never fires
 * onData/onExit, so a test driving a real shell asserts on events that never
 * arrive and passes vacuously — which is how the close/exit bug shipped twice.
 */
class FakePty implements PtyProcess {
    static nextPid = 1000;
    readonly pid = FakePty.nextPid++;
    killed = false;
    written = "";
    #data: ((data: string) => void) | null = null;
    #exit: ((event: { exitCode: number; signal?: number | undefined }) => void) | null = null;

    onData(listener: (data: string) => void): void {
        this.#data = listener;
    }
    onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void {
        this.#exit = listener;
    }
    write(data: string): void {
        this.written += data;
    }
    resize(): void {}
    /** What node-pty really does: killing a PTY makes it fire `onExit`. */
    kill(): void {
        this.killed = true;
        this.#exit?.({ exitCode: 0 });
    }
    emitData(data: string): void {
        this.#data?.(data);
    }
    emitExit(exitCode: number): void {
        this.#exit?.({ exitCode });
    }
}

function harness() {
    const spawned: FakePty[] = [];
    const sizes: Array<{ cols: number; rows: number }> = [];
    const terminals = new TerminalManager((input) => {
        const fake = new FakePty();
        spawned.push(fake);
        sizes.push({ cols: input.cols, rows: input.rows });
        return fake;
    });
    const events: TerminalOutput[] = [];
    terminals.on("output", (event) => events.push(event));
    return { terminals, events, spawned, sizes };
}

/**
 * Open, then report a size the way a mounted pane does.
 *
 * The shell is not spawned until the size is known, so most tests need both
 * halves — see the deferred-spawn tests for the behaviour itself.
 */
const open = (terminals: TerminalManager, terminalId = "term-1") => {
    terminals.open({ threadId: "t", terminalId, cwd: tmpdir() });
    terminals.resize("t", terminalId, 72, 40);
    // After the resize, because that is what starts the shell — the snapshot
    // `open` returns is still "starting" and has no pid.
    return terminals.snapshot("t", terminalId)!;
};

describe("TerminalManager", () => {
    test("a closed terminal reports `closed` and never `exited`", () => {
        // The reopen bug. Killing the PTY fires onExit, so closing used to report
        // BOTH — and the trailing `exited` was the state a reopened pane woke up
        // to, because the renderer caches an attach stream per terminal id. It read
        // as a shell that had just died, so the pane closed its own surface and the
        // terminal appeared to open and instantly vanish.
        const { terminals, events, spawned } = harness();
        open(terminals);
        terminals.close("t", "term-1");

        expect(spawned[0]!.killed).toBe(true);
        expect(events.map((event) => event.type)).toEqual(["started", "closed"]);
    });

    test("a shell that exits on its own still reports `exited`", () => {
        const { terminals, events, spawned } = harness();
        open(terminals);
        spawned[0]!.emitExit(0);

        expect(events.map((event) => event.type)).toEqual(["started", "exited"]);
    });

    test("closing a whole thread reports every terminal once", () => {
        const { terminals, events } = harness();
        open(terminals, "term-1");
        open(terminals, "term-2");
        terminals.close("t");

        expect(events.map((event) => event.type)).toEqual(["started", "started", "closed", "closed"]);
    });

    test("reopening a closed id spawns a new shell rather than reattaching", () => {
        const { terminals, spawned } = harness();
        const first = open(terminals);
        spawned[0]!.emitData("stale scrollback");
        terminals.close("t", "term-1");

        expect(terminals.snapshot("t", "term-1")).toBeNull();
        const second = open(terminals);
        expect(second.status).toBe("running");
        expect(second.pid).not.toBe(first.pid);
        // A fresh shell starts empty, not with the dead one's scrollback.
        expect(second.history).toBe("");
    });

    test("a spawned shell announces itself with a fresh snapshot", () => {
        // The doubled prompt on reopen. The renderer caches one attach stream per
        // terminal id, so a reopened terminal wakes up holding the DEAD session's
        // scrollback and paints it before the new shell says anything. `started`
        // carries a snapshot the client uses to REPLACE its buffer, so the new
        // prompt is not appended below the ghost of the old one.
        const { terminals, events, spawned } = harness();
        open(terminals);
        spawned[0]!.emitData("fresh prompt");

        const started = events.find((event) => event.type === "started");
        expect(started).toBeDefined();
        expect(started!.snapshot?.status).toBe("running");
        // Emitted BEFORE any output, or the buffer it carries would already be
        // stale by the time the client applied it.
        expect(started!.snapshot?.history).toBe("");
        expect(events.map((event) => event.type)).toEqual(["started", "output"]);
    });

    test("open on a live id reattaches to the same process", () => {
        const { terminals, spawned } = harness();
        const first = open(terminals);
        const second = open(terminals);
        expect(second.pid).toBe(first.pid);
        expect(spawned).toHaveLength(1);
    });

    test("list reports live sessions and drops closed ones", () => {
        const { terminals } = harness();
        open(terminals, "term-1");
        open(terminals, "term-2");
        expect(
            terminals
                .list()
                .map((entry) => entry.terminalId)
                .sort(),
        ).toEqual(["term-1", "term-2"]);

        terminals.close("t", "term-1");
        expect(terminals.list().map((entry) => entry.terminalId)).toEqual(["term-2"]);
    });

    test("the shell is not spawned until the pane reports its size", () => {
        // The stray `%`: zsh prints its partial-line marker as `%` plus COLUMNS-1
        // spaces and then erases it by wrapping the line. Born at the placeholder
        // 80 and resized afterwards, that padding overshot the real pane, the line
        // wrapped early, the erase landed a row too low and the `%` stayed.
        const { terminals, spawned, sizes } = harness();
        terminals.open({ threadId: "t", terminalId: "term-1", cwd: tmpdir() });
        expect(spawned).toHaveLength(0);
        expect(terminals.snapshot("t", "term-1")?.status).toBe("starting");

        terminals.resize("t", "term-1", 72, 40);
        expect(spawned).toHaveLength(1);
        expect(sizes[0]).toEqual({ cols: 72, rows: 40 });
        expect(terminals.snapshot("t", "term-1")?.status).toBe("running");
    });

    test("a size given up front spawns immediately", () => {
        const { terminals, spawned, sizes } = harness();
        terminals.open({ threadId: "t", terminalId: "term-1", cwd: tmpdir(), cols: 100, rows: 30 });
        expect(spawned).toHaveLength(1);
        expect(sizes[0]).toEqual({ cols: 100, rows: 30 });
    });

    test("a pane that never reports a size still gets a shell", async () => {
        const { terminals, spawned } = harness();
        terminals.open({ threadId: "t", terminalId: "term-1", cwd: tmpdir() });
        expect(spawned).toHaveLength(0);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(spawned).toHaveLength(1);
        expect(terminals.snapshot("t", "term-1")?.status).toBe("running");
    }, 5_000);

    test("later resizes go to the shell rather than spawning another", () => {
        const { terminals, spawned } = harness();
        open(terminals);
        terminals.resize("t", "term-1", 90, 50);
        terminals.resize("t", "term-1", 91, 51);
        expect(spawned).toHaveLength(1);
    });

    test("input typed before the shell starts is replayed, not dropped", () => {
        const { terminals, spawned } = harness();
        terminals.open({ threadId: "t", terminalId: "term-1", cwd: tmpdir() });
        terminals.write("t", "term-1", "echo hi\r");
        expect(spawned).toHaveLength(0);

        terminals.resize("t", "term-1", 72, 40);
        expect(spawned[0]!.written).toBe("echo hi\r");
    });

    test("closing before the shell starts spawns nothing", async () => {
        const { terminals, spawned, events } = harness();
        terminals.open({ threadId: "t", terminalId: "term-1", cwd: tmpdir() });
        terminals.close("t", "term-1");
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(spawned).toHaveLength(0);
        expect(events.map((event) => event.type)).toEqual(["closed"]);
    }, 5_000);

    test("scrollback accumulates and rides the snapshot", () => {
        const { terminals, spawned } = harness();
        open(terminals);
        spawned[0]!.emitData("one\n");
        spawned[0]!.emitData("two\n");
        expect(terminals.snapshot("t", "term-1")?.history).toBe("one\ntwo\n");
    });

    /**
     * Scrollback is trimmed lazily — the buffer overshoots the cap and collapses
     * in one pass rather than on every chunk — so the cap is an invariant of the
     * snapshot, not of the buffer. A chatty shell is the case that matters: it is
     * exactly the one that used to rebuild a 256KB string per chunk.
     */
    test("scrollback stays capped at the tail however many chunks arrive", () => {
        const { terminals, spawned } = harness();
        open(terminals);
        // Small chunks, far past the cap: the path a build or an install takes.
        for (let index = 0; index < 100_000; index += 1) spawned[0]!.emitData("0123456789");
        spawned[0]!.emitData("THE-END");

        const history = terminals.snapshot("t", "term-1")!.history;
        expect(history.length).toBe(256 * 1024);
        expect(history.endsWith("THE-END")).toBe(true);
    });

    /** A snapshot of a terminal that has gone quiet is stable across reads. */
    test("repeated snapshots of idle scrollback agree", () => {
        const { terminals, spawned } = harness();
        open(terminals);
        for (let index = 0; index < 50_000; index += 1) spawned[0]!.emitData("chunk");

        expect(terminals.snapshot("t", "term-1")!.history).toBe(terminals.snapshot("t", "term-1")!.history);
    });
});

/**
 * The attach boundary.
 *
 * A client has to subscribe before it asks for a snapshot, or it loses
 * whatever the shell writes during the round trip — but that means the chunks
 * it buffers straddle the snapshot, and the ones already inside `history`
 * would be painted twice. `sequence` is what separates them, so the invariant
 * the renderer leans on is that a snapshot's count is exactly the number of
 * chunks its own `history` contains.
 */
describe("output sequence", () => {
    test("counts every chunk, and a snapshot agrees with its history", () => {
        const { terminals, spawned } = harness();
        terminals.open({ threadId: "t1", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
        const pty = spawned[0];

        expect(terminals.snapshot("t1", "a")?.sequence).toBe(0);

        pty?.emitData("one\n");
        pty?.emitData("two\n");
        const after = terminals.snapshot("t1", "a");
        expect(after?.sequence).toBe(2);
        expect(after?.history).toBe("one\ntwo\n");

        pty?.emitData("three\n");
        expect(terminals.snapshot("t1", "a")?.sequence).toBe(3);
    });

    test("every output event carries its own position", () => {
        const { terminals, events, spawned } = harness();
        terminals.open({ threadId: "t1", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
        spawned[0]?.emitData("a");
        spawned[0]?.emitData("b");
        expect(events.filter((event) => event.type === "output").map((event) => event.sequence)).toEqual([1, 2]);
    });

    /**
     * `clear` wipes the scrollback but must NOT rewind the count: a client that
     * reattached afterwards would measure new chunks against a boundary they
     * had already passed and drop them.
     */
    test("clearing the scrollback does not rewind the count", () => {
        const { terminals, spawned } = harness();
        terminals.open({ threadId: "t1", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
        spawned[0]?.emitData("one\n");
        terminals.clear("t1", "a");

        const cleared = terminals.snapshot("t1", "a");
        expect(cleared?.history).toBe("");
        expect(cleared?.sequence).toBe(1);

        spawned[0]?.emitData("two\n");
        expect(terminals.snapshot("t1", "a")?.sequence).toBe(2);
    });

    /** A respawn under a reused id starts its own count from zero. */
    test("a restarted shell starts counting again", () => {
        const { terminals, spawned } = harness();
        terminals.open({ threadId: "t1", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
        spawned[0]?.emitData("one\n");
        spawned[0]?.emitExit(0);

        terminals.open({ threadId: "t1", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
        expect(terminals.snapshot("t1", "a")?.sequence).toBe(0);
        spawned[1]?.emitData("fresh\n");
        expect(terminals.snapshot("t1", "a")?.sequence).toBe(1);
    });
});

/**
 * What a spawn failure does.
 *
 * The real one that shipped: node-pty leaks a /dev/ptmx fd per spawn on macOS,
 * so after a couple of hundred terminals `posix_openpt` starts failing and
 * every shell after that refuses to start. node-pty reported it as the
 * catch-all "posix_spawnp failed." (both errors take the same exit), and
 * because the spawn happens on the first resize the throw came back as a
 * rejected `loop:pty.resize` — a dialog about an IPC method, over a pane that
 * stayed blank forever. The leak itself is fixed by node-pty 1.2.0-beta; this
 * covers the shell's half, which has to hold for any failing spawn.
 */
describe("a spawn that fails", () => {
    function failing(message = "posix_spawnp failed.") {
        const terminals = new TerminalManager(() => {
            throw new Error(message);
        });
        const events: TerminalOutput[] = [];
        terminals.on("output", (event) => events.push(event));
        return { terminals, events };
    }

    test("reports the reason into the pane instead of throwing at the caller", () => {
        const { terminals, events } = failing();
        terminals.open({ threadId: "t", terminalId: "a", cwd: tmpdir() });
        // The resize is where the spawn happens, and it must not reject.
        expect(() => terminals.resize("t", "a", 72, 40)).not.toThrow();

        const snapshot = terminals.snapshot("t", "a")!;
        expect(snapshot.status).toBe("error");
        expect(snapshot.pid).toBeNull();
        expect(snapshot.history).toContain("posix_spawnp failed.");
        // `output` puts it on screen; `exited` settles a pane that would otherwise
        // sit on "starting" waiting for a shell that is never coming.
        expect(events.map((event) => event.type)).toEqual(["output", "exited"]);
    });

    test("a failure inside open is reported the same way", () => {
        const { terminals, events } = failing();
        // The size is already known here, so open spawns directly.
        const snapshot = terminals.open({ threadId: "t", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
        expect(snapshot.status).toBe("error");
        expect(events.map((event) => event.type)).toEqual(["output", "exited"]);
    });

    test("later resizes do not retry the spawn", () => {
        let attempts = 0;
        const terminals = new TerminalManager(() => {
            attempts += 1;
            throw new Error("posix_spawnp failed.");
        });
        terminals.open({ threadId: "t", terminalId: "a", cwd: tmpdir() });
        terminals.resize("t", "a", 72, 40);
        terminals.resize("t", "a", 100, 50);
        terminals.resize("t", "a", 120, 60);

        expect(attempts).toBe(1);
    });

    /** Reopening the pane is the retry, so a transient failure is recoverable. */
    test("reopening starts a fresh session", () => {
        let attempts = 0;
        const spawned: FakePty[] = [];
        const terminals = new TerminalManager(() => {
            attempts += 1;
            if (attempts === 1) throw new Error("posix_spawnp failed.");
            const fake = new FakePty();
            spawned.push(fake);
            return fake;
        });
        terminals.open({ threadId: "t", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
        expect(terminals.snapshot("t", "a")?.status).toBe("error");

        terminals.open({ threadId: "t", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
        const snapshot = terminals.snapshot("t", "a")!;
        expect(snapshot.status).toBe("running");
        expect(snapshot.pid).toBe(spawned[0]!.pid);
        // The dead session's notice does not follow the new shell into the pane.
        expect(snapshot.history).toBe("");
    });
});

/**
 * Which shell a pane opens, and how.
 *
 * The bug: the packaged app opened zsh for everyone regardless of their login
 * shell, and the shell it opened had none of their PATH. Both come from the
 * same fact — a GUI launch (Finder/Dock/Spotlight) inherits launchd's
 * environment, which has neither SHELL nor PATH set. `process.env.SHELL` is
 * only populated when the app is started from a terminal, which is exactly the
 * case a developer tests in and a user never hits.
 */
describe("which shell a pane opens", () => {
    function spy() {
        const calls: Array<{ shell: string; args: readonly string[] }> = [];
        const terminals = new TerminalManager((input) => {
            calls.push({ shell: input.shell, args: input.args });
            return new FakePty();
        });
        return { terminals, calls };
    }

    const start = (terminals: TerminalManager) =>
        terminals.open({ threadId: "t", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });

    test("falls back to the login shell when SHELL is unset", () => {
        const saved = process.env["SHELL"];
        delete process.env["SHELL"];
        try {
            const { terminals, calls } = spy();
            start(terminals);
            // The passwd entry, not the hardcoded default — those coincide on this
            // machine, so assert against the source rather than a literal.
            expect(calls[0]!.shell).toBe(userInfo().shell || "/bin/zsh");
        } finally {
            if (saved === undefined) delete process.env["SHELL"];
            else process.env["SHELL"] = saved;
        }
    });

    test("an explicit SHELL still wins", () => {
        const saved = process.env["SHELL"];
        process.env["SHELL"] = "/bin/bash";
        try {
            const { terminals, calls } = spy();
            start(terminals);
            expect(calls[0]!.shell).toBe("/bin/bash");
        } finally {
            if (saved === undefined) delete process.env["SHELL"];
            else process.env["SHELL"] = saved;
        }
    });

    test.skipIf(process.platform !== "darwin")("starts a login shell on macOS, so PATH is actually built", () => {
        // Without -l, zsh reads .zshrc and never .zprofile — where homebrew's
        // shellenv and most PATH setup lives. The pane looked right and had none
        // of the user's tools on PATH.
        const { terminals, calls } = spy();
        start(terminals);
        expect(calls[0]!.args).toEqual(["-l"]);
    });

    test.skipIf(process.platform !== "darwin")("an exotic shell gets no unknown flag", () => {
        const saved = process.env["SHELL"];
        process.env["SHELL"] = "/opt/weird/myshell";
        try {
            const { terminals, calls } = spy();
            start(terminals);
            // Passing -l blindly would fail to start a shell that does not take it,
            // and a terminal with the wrong PATH beats no terminal at all.
            expect(calls[0]!.args).toEqual([]);
        } finally {
            if (saved === undefined) delete process.env["SHELL"];
            else process.env["SHELL"] = saved;
        }
    });

    test("Electron's own variables do not reach the shell", () => {
        // ELECTRON_RUN_AS_NODE makes any Electron binary run as plain node, so
        // leaking it breaks every Electron tool the user runs in the pane.
        process.env["ELECTRON_RUN_AS_NODE"] = "1";
        try {
            const terminals = new TerminalManager(() => new FakePty());
            terminals.open({ threadId: "t", terminalId: "a", cwd: tmpdir(), cols: 80, rows: 24 });
            // The session's env is what the spawn receives; assert through a spy.
            const captured: Array<Record<string, string>> = [];
            const spied = new TerminalManager((input) => {
                captured.push(input.env);
                return new FakePty();
            });
            spied.open({ threadId: "t", terminalId: "b", cwd: tmpdir(), cols: 80, rows: 24 });
            expect(captured[0]!["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
            expect(captured[0]!["TERM"]).toBe("xterm-256color");
        } finally {
            delete process.env["ELECTRON_RUN_AS_NODE"];
        }
    });
});
