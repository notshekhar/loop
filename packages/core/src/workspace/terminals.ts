/**
 * Real PTYs for the terminal panel.
 *
 * Like the filesystem, this lives in the shell rather than in loop: loop's RPC
 * is an agent protocol and has no terminal, and a browser cannot fork a shell.
 *
 * Terminal ids are chosen by the renderer and sent explicitly — the contract is
 * emphatic that there is no server-side allocation — so this is a plain map
 * keyed by `threadId:terminalId`, and reopening an id that already exists
 * attaches to the running process instead of starting a second one.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";

/** Enough scrollback to restore a useful screen on reattach, bounded. */
const MAX_HISTORY_CHARS = 256 * 1024;

/**
 * How far scrollback is allowed to overshoot the cap before it is compacted.
 *
 * See `appendHistory` — the slack is what makes trimming amortized rather than
 * per-chunk.
 */
const HISTORY_COMPACT_AT = MAX_HISTORY_CHARS * 2;

/**
 * Scrollback, held as the chunks that produced it.
 *
 * This was a plain string that every chunk rebuilt: `history = (history +
 * data).slice(-MAX_HISTORY_CHARS)`. That allocates two ~256KB strings per
 * chunk, and a build or an install emits thousands of small chunks a second —
 * hundreds of MB/s of garbage per terminal, for a buffer almost nobody reads
 * (only `snapshotOf`, on reattach).
 *
 * Appending to an array instead costs a push. The trim cannot run per chunk
 * either way: `shift()` on the tens of thousands of small chunks that fit in
 * the cap is its own O(n) move. So the buffer overshoots to
 * HISTORY_COMPACT_AT and collapses in one pass, which is O(buffer) but paid
 * once per MAX_HISTORY_CHARS written — constant per chunk, amortized.
 */
interface HistoryBuffer {
    chunks: string[];
    /** Total characters across `chunks`, maintained incrementally. */
    length: number;
}

function emptyHistory(): HistoryBuffer {
    return { chunks: [], length: 0 };
}

function appendHistory(buffer: HistoryBuffer, data: string): void {
    buffer.chunks.push(data);
    buffer.length += data.length;
    if (buffer.length <= HISTORY_COMPACT_AT) return;
    collapseHistory(buffer);
}

/** Join to a single chunk and drop everything past the cap. */
function collapseHistory(buffer: HistoryBuffer): string {
    const joined = buffer.chunks.join("").slice(-MAX_HISTORY_CHARS);
    buffer.chunks = joined === "" ? [] : [joined];
    buffer.length = joined.length;
    return joined;
}

/**
 * Scrollback as one string, never longer than the cap.
 *
 * Collapses in place, so repeated snapshots of a terminal that has since gone
 * quiet re-join nothing.
 */
function readHistory(buffer: HistoryBuffer): string {
    if (buffer.chunks.length === 1) return buffer.chunks[0]!;
    return collapseHistory(buffer);
}

/**
 * How long `open` waits for the renderer to report the pane's real size before
 * starting the shell anyway.
 *
 * The renderer can only measure its surface once it has mounted, and a shell
 * inherits `COLUMNS` from the PTY it is born into — so starting one before the
 * size is known bakes in the wrong width (see `#start`). The grace period is
 * generous enough for a mount and short enough that a pane which never reports
 * a size still gets a working terminal.
 */
const SPAWN_SIZE_GRACE_MS = 750;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalSnapshot {
    readonly threadId: string;
    readonly terminalId: string;
    readonly cwd: string;
    readonly worktreePath: string | null;
    /** Mirrors the contract's TerminalSessionStatus, which has no "closed". */
    readonly status: "starting" | "running" | "exited" | "error";
    readonly pid: number | null;
    readonly history: string;
    readonly exitCode: number | null;
    readonly exitSignal: number | null;
    readonly label: string;
    readonly updatedAt: string;
    /**
     * How many output chunks this shell has produced, as of this snapshot.
     *
     * The boundary marker between `history` and live output. A client subscribes
     * before it asks for a snapshot — it has to, or the prompt written during the
     * round trip is lost — which means the chunks it buffers in the meantime
     * straddle the snapshot: the ones taken before `history` was captured are
     * already inside it, and painting them again would double the prompt. The
     * count says which is which, exactly, with no reliance on two IPC channels
     * arriving in order.
     *
     * Counts chunks rather than bytes because a chunk is what an event carries;
     * the two halves only ever compare it against itself.
     */
    readonly sequence: number;
}

export interface TerminalOutput {
    readonly threadId: string;
    readonly terminalId: string;
    readonly type: "output" | "exited" | "closed" | "started";
    readonly data?: string;
    readonly exitCode?: number | null;
    readonly exitSignal?: number | null;
    /** On `output`: this chunk's position in the stream. See TerminalSnapshot. */
    readonly sequence?: number;
    /**
     * Present on `started`: the shell that has just been spawned.
     *
     * The renderer caches one attach stream per terminal id for minutes after its
     * last subscriber leaves, so a terminal reopened under a reused id wakes up
     * holding the DEAD session's scrollback and paints it before the new shell
     * says anything. Announcing the spawn lets that stream replace its buffer
     * outright instead of appending a second prompt below the ghost of the first.
     */
    readonly snapshot?: TerminalSnapshot;
}

interface Session {
    readonly threadId: string;
    readonly terminalId: string;
    readonly cwd: string;
    readonly worktreePath: string | null;
    readonly env: Record<string, string>;
    /** Null until the shell is spawned — see SPAWN_SIZE_GRACE_MS. */
    process: PtyProcess | null;
    history: HistoryBuffer;
    status: "starting" | "running" | "exited" | "error";
    exitCode: number | null;
    exitSignal: number | null;
    updatedAt: string;
    /** Anything written before the shell existed, replayed once it does. */
    pendingInput: string;
    /** Output chunks emitted so far — the attach boundary. See TerminalSnapshot. */
    sequence: number;
    /** Fires the spawn if no size ever arrives. */
    spawnTimer: ReturnType<typeof setTimeout> | null;
    /**
     * Set by `close` before it kills the process.
     *
     * Killing a PTY makes it fire `onExit`, so a closed terminal reported BOTH
     * `closed` and, a tick later, `exited` — and the second one is an artifact of
     * the close, not a process that died on its own. It mattered because the
     * renderer caches an attach stream per terminal id and reopening reuses it:
     * the pane mounted, compared the cached `exited` against its initial
     * `closed`, concluded the shell had just died and closed its own surface. The
     * terminal appeared to open and vanish.
     */
    closing: boolean;
}

const key = (threadId: string, terminalId: string) => `${threadId}:${terminalId}`;

/**
 * The user's login shell, resolved the way VS Code resolves it.
 *
 * `process.env.SHELL` is only set when the app was started FROM a terminal. A
 * GUI launch — Finder, Dock, Spotlight — inherits launchd's environment, and
 * that environment has no SHELL at all (`launchctl getenv SHELL` comes back
 * empty). So the packaged app always fell through to the hardcoded default and
 * opened zsh for everyone, whatever their actual login shell was.
 *
 * `os.userInfo().shell` reads the passwd database — the same source as
 * `dscl . -read /Users/<me> UserShell` — which is what the login shell really
 * is, no matter how the app was started. The env still wins when it is set, so
 * a shell deliberately overridden for a dev run is still honoured.
 */
function defaultShell(): string {
    if (platform() === "win32") return process.env["COMSPEC"] ?? "powershell.exe";
    const fromEnv = process.env["SHELL"];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    try {
        const { shell } = userInfo();
        if (shell) return shell;
    } catch {
        // No passwd entry for this uid — possible in a container. Fall through.
    }
    return "/bin/zsh";
}

/**
 * Shells that are known to take `-l` to mean "login shell".
 *
 * An allowlist rather than passing `-l` blindly: an unrecognised shell that
 * does not understand the flag would fail to start at all, and a terminal that
 * opens with the wrong PATH beats one that does not open.
 */
const LOGIN_FLAG_SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu"]);

/**
 * Start the shell as a LOGIN shell on macOS, as VS Code and Terminal.app do.
 *
 * The same empty GUI environment that hides SHELL also hides PATH — `launchctl
 * getenv PATH` is empty too — so a shell spawned by a Finder-launched app
 * starts with a bare `/usr/bin:/bin:/usr/sbin:/sbin`. zsh reads `.zprofile`,
 * where homebrew's `shellenv` and most PATH setup lives, ONLY for login shells;
 * an interactive non-login shell reads `.zshrc` and stops. That is why the pane
 * looked almost right and wasn't: the prompt was there, and `brew`, `bun`,
 * `~/.local/bin` and everything else the user installed were not.
 *
 * Linux gets no flag, matching VS Code: a Linux desktop session already hands
 * the app the user's environment, so the login files have run.
 */
/**
 * Electron's own variables, which a shell must not inherit.
 *
 * `ELECTRON_RUN_AS_NODE=1` makes any Electron binary behave as plain node, so
 * leaking it into the pane silently breaks every Electron-based tool the user
 * runs there — including loop's own desktop app. VS Code strips the same set
 * for the same reason.
 */
const STRIPPED_ENV = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_NO_ASAR"];

/** The environment a pane's shell is born into. */
function shellEnv(overrides: Record<string, string> | undefined): Record<string, string> {
    const env = { ...process.env, ...overrides, TERM: "xterm-256color" } as Record<string, string>;
    for (const name of STRIPPED_ENV) delete env[name];
    return env;
}

function shellArgs(shell: string): string[] {
    if (platform() !== "darwin") return [];
    const name = shell.slice(shell.lastIndexOf("/") + 1);
    return LOGIN_FLAG_SHELLS.has(name) ? ["-l"] : [];
}

export declare interface TerminalManager {
    on(event: "output", listener: (event: TerminalOutput) => void): this;
}

/**
 * Just enough of `pty.IPty` for this module, so a test can supply its own.
 *
 * node-pty spawns under Bun but never fires `onData`/`onExit` there (see
 * [[drover-pty-under-bun]]) — the callbacks only run in Electron's Node. A test
 * that drove a real shell would therefore assert on events that never arrive
 * and pass vacuously, which is exactly how the close/exit bug survived. So the
 * spawn is injectable and the lifecycle is tested against a fake.
 */
export interface PtyProcess {
    readonly pid: number;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}

export type PtySpawner = (input: {
    readonly shell: string;
    /** `-l` on macOS, so the login files that build PATH actually run. */
    readonly args: readonly string[];
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly env: Record<string, string>;
}) => PtyProcess;

export class TerminalManager extends EventEmitter {
    #sessions = new Map<string, Session>();
    readonly #spawn: PtySpawner;

    constructor(spawn: PtySpawner) {
        super();
        this.#spawn = spawn;
    }

    /** Reattaches when the id is already live; starts a shell otherwise. */
    open(input: {
        threadId: string;
        terminalId: string;
        cwd: string;
        worktreePath?: string | null;
        cols?: number;
        rows?: number;
        env?: Record<string, string>;
    }): TerminalSnapshot {
        // `error` joins `exited` as a dead session: reopening the pane is how a
        // user retries a spawn that failed for a transient reason, so it has to
        // build a fresh session rather than hand back the corpse of the last one.
        const existing = this.#sessions.get(key(input.threadId, input.terminalId));
        if (existing && existing.status !== "exited" && existing.status !== "error") return snapshotOf(existing);

        // An unreachable cwd would make the spawn throw with a message that says
        // nothing useful; fall back so a terminal still opens.
        const cwd = existsSync(input.cwd) ? input.cwd : homedir();
        const session: Session = {
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd,
            worktreePath: input.worktreePath ?? null,
            env: shellEnv(input.env),
            process: null,
            history: emptyHistory(),
            status: "starting",
            exitCode: null,
            exitSignal: null,
            updatedAt: new Date().toISOString(),
            pendingInput: "",
            sequence: 0,
            spawnTimer: null,
            closing: false,
        };
        this.#sessions.set(key(input.threadId, input.terminalId), session);

        // A caller that already knows the geometry gets its shell immediately.
        if (input.cols !== undefined && input.rows !== undefined) {
            this.#start(session, input.cols, input.rows);
            return snapshotOf(session);
        }

        session.spawnTimer = setTimeout(() => {
            session.spawnTimer = null;
            if (session.process === null) this.#start(session, DEFAULT_COLS, DEFAULT_ROWS);
        }, SPAWN_SIZE_GRACE_MS);
        return snapshotOf(session);
    }

    /**
     * Start the shell, now that its size is settled.
     *
     * Split out of `open` because the size is the whole point: a shell inherits
     * `COLUMNS` from the PTY it is born into, and zsh's very first act is to
     * print `%` followed by `COLUMNS - 1` spaces so the line wraps, then erase it
     * with `CR space CR` (its PROMPT_SP partial-line marker). Spawning at the
     * placeholder 80 and resizing a moment later made that padding too long for
     * the real pane: the line wrapped early, the erase landed on the row below,
     * and a stray `%` was left on the first line of every terminal.
     */
    #start(session: Session, cols: number, rows: number): void {
        const shell = defaultShell();
        let child: PtyProcess;
        try {
            child = this.#spawn({
                shell,
                args: shellArgs(shell),
                cwd: session.cwd,
                cols,
                rows,
                env: session.env,
            });
        } catch (error) {
            this.#fail(session, error);
            return;
        }
        session.process = child;
        session.status = "running";
        session.updatedAt = new Date().toISOString();

        child.onData((data) => {
            appendHistory(session.history, data);
            // Incremented with the append, so a snapshot taken at any point carries
            // the count of exactly the chunks its `history` already contains.
            session.sequence += 1;
            session.updatedAt = new Date().toISOString();
            this.emit("output", {
                threadId: session.threadId,
                terminalId: session.terminalId,
                type: "output",
                data,
                sequence: session.sequence,
            });
        });

        child.onExit(({ exitCode, signal }) => {
            session.status = "exited";
            session.exitCode = exitCode;
            session.exitSignal = signal ?? null;
            session.updatedAt = new Date().toISOString();
            // `close` already reported this terminal as closed and killing the PTY is
            // what brought us here — see Session.closing.
            if (session.closing) return;
            this.emit("output", {
                threadId: session.threadId,
                terminalId: session.terminalId,
                type: "exited",
                exitCode,
                exitSignal: signal ?? null,
            });
        });

        // Before any output, so a listener holding a previous session's scrollback
        // clears it rather than appending this shell's prompt underneath.
        this.emit("output", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            type: "started",
            snapshot: snapshotOf(session),
        });

        if (session.pendingInput !== "") {
            child.write(session.pendingInput);
            session.pendingInput = "";
        }
    }

    /**
     * A shell that could not be spawned, reported into the pane rather than out
     * of the IPC call.
     *
     * The spawn happens on the first `resize` — that is where the pane's real
     * size finally arrives, see #start — so letting the throw propagate rejected
     * a resize with a message no user could act on ("posix_spawnp failed"), left
     * the session at `starting` with a null process forever, and made every
     * later resize try to spawn again. The pane just stayed blank.
     *
     * Writing the reason into `history` is what puts it on screen: the pane
     * paints history verbatim, so this is the only channel that reaches a user
     * who is looking at an empty terminal and not at a devtools console.
     */
    #fail(session: Session, error: unknown): void {
        const reason = error instanceof Error ? error.message : String(error);
        session.status = "error";
        session.process = null;
        session.updatedAt = new Date().toISOString();

        const notice = `\r\nloop: could not start a shell in ${session.cwd}\r\n      ${reason}\r\n`;
        appendHistory(session.history, notice);
        session.sequence += 1;
        this.emit("output", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            type: "output",
            data: notice,
            sequence: session.sequence,
        });
        // Settles the pane's own status. Without it the surface sits on "starting"
        // waiting for a shell that is never coming.
        this.emit("output", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            type: "exited",
            exitCode: null,
            exitSignal: null,
        });
    }

    snapshot(threadId: string, terminalId: string): TerminalSnapshot | null {
        const session = this.#sessions.get(key(threadId, terminalId));
        return session ? snapshotOf(session) : null;
    }

    write(threadId: string, terminalId: string, data: string): void {
        const session = this.#sessions.get(key(threadId, terminalId));
        if (!session) return;
        // Typing into a terminal whose shell has not started yet is rare but real
        // (a script runs a command the moment it opens the panel); hold it rather
        // than dropping it on the floor.
        if (session.process === null) session.pendingInput += data;
        else session.process.write(data);
    }

    /**
     * The pane's real geometry — and, the first time, the shell's starting size.
     *
     * The renderer measures its surface after mounting, so this is where the true
     * size first becomes known. Starting the shell here rather than in `open` is
     * what keeps zsh's partial-line marker from being left on screen; see #start.
     */
    resize(threadId: string, terminalId: string, cols: number, rows: number): void {
        const session = this.#sessions.get(key(threadId, terminalId));
        // `error` too, or a pane that keeps reporting its size would retry a
        // failing spawn on every one — which is how a single failure turned into a
        // stream of them. Retrying is `open`'s job, not a resize's.
        if (!session || session.status === "exited" || session.status === "error") return;
        // node-pty throws on a zero dimension, which a hidden panel can report.
        if (cols < 1 || rows < 1) return;
        if (session.process === null) {
            if (session.spawnTimer !== null) {
                clearTimeout(session.spawnTimer);
                session.spawnTimer = null;
            }
            this.#start(session, cols, rows);
            return;
        }
        session.process.resize(cols, rows);
    }

    clear(threadId: string, terminalId: string): void {
        const session = this.#sessions.get(key(threadId, terminalId));
        if (session) session.history = emptyHistory();
    }

    /** Closes one terminal, or every terminal of a thread when the id is absent
     *  — which is what the contract means by an optional terminalId. */
    close(threadId: string, terminalId?: string): void {
        const targets =
            terminalId === undefined
                ? [...this.#sessions.values()].filter((session) => session.threadId === threadId)
                : [this.#sessions.get(key(threadId, terminalId))].filter((s): s is Session => s !== undefined);

        for (const session of targets) {
            this.#sessions.delete(key(session.threadId, session.terminalId));
            session.closing = true;
            if (session.spawnTimer !== null) {
                clearTimeout(session.spawnTimer);
                session.spawnTimer = null;
            }
            session.process?.kill();
            this.emit("output", {
                threadId: session.threadId,
                terminalId: session.terminalId,
                type: "closed",
            });
        }
    }

    /**
     * Every live session, for the renderer's metadata subscription.
     *
     * The panel derives two things from this that it cannot derive locally: the
     * tab labels, and which ids are taken. Without it the id allocator only saw
     * the renderer's own list, so a terminal closed and reopened always got the
     * same `term-1` back and collided with the stream the previous one left
     * behind.
     */
    list(): TerminalSnapshot[] {
        return [...this.#sessions.values()].map(snapshotOf);
    }

    /** Kills everything; called when the window goes away. */
    closeAll(): void {
        for (const session of this.#sessions.values()) {
            session.closing = true;
            if (session.spawnTimer !== null) clearTimeout(session.spawnTimer);
            session.process?.kill();
        }
        this.#sessions.clear();
    }
}

function snapshotOf(session: Session): TerminalSnapshot {
    return {
        threadId: session.threadId,
        terminalId: session.terminalId,
        cwd: session.cwd,
        worktreePath: session.worktreePath,
        status: session.status,
        pid: session.status === "running" ? (session.process?.pid ?? null) : null,
        history: readHistory(session.history),
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        label: session.cwd.slice(session.cwd.lastIndexOf("/") + 1) || "terminal",
        updatedAt: session.updatedAt,
        sequence: session.sequence,
    };
}
