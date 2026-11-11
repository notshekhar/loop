/**
 * Background shells — commands that outlive the tool call that started them.
 *
 * A foreground bash run is bounded by a timeout because an unbounded one is
 * INVISIBLE: the bug this guards against is a forgotten command still running
 * thirty minutes later with nothing on screen saying so. Backgrounding trades
 * that bound for visibility — every shell here is listed in the shells panel
 * and reachable through the `shells` tool, so it can run as long as it needs.
 *
 * Ownership is the session's, not the turn's: aborting a turn (esc) must not
 * kill a dev server the user asked for. The bound that remains is the process:
 * shells are registered in memory, never persisted, and killed on exit. A
 * resumed session in a new process does NOT adopt the old one's children —
 * adopting an orphan tree means owning reaping and authorization, and a
 * half-owned process tree is worse than none. (opencode reached the same
 * conclusion from the other direction: their background launch is gated behind
 * "persist job status and define restart recovery" for exactly this reason.)
 *
 * Output goes to a file from byte zero rather than through OutputAccumulator.
 * The accumulator keeps a bounded tail, which is right for a run you are
 * waiting on and wrong for one you poll: a dev server can log for an hour
 * between reads, and the interesting part is what arrived SINCE the last read.
 * A file gives that as an offset, costs no memory, and hands the user a path
 * they can tail themselves.
 *
 * Those writes are SYNCHRONOUS. A WriteStream buffers, and the first thing
 * anyone does with a new shell is read it — the tool call that starts one
 * literally says "read it with shells" — so a buffered write means the first
 * read comes back empty and the output looks lost. Writing through the fd
 * keeps the byte counter and the file exactly equal at all times, which is
 * what makes an offset read trustworthy.
 *
 * Offsets count every byte the shell ever printed, while the file holds only
 * its recent part (shell-logs.ts): `logStart` is the offset of the file's first
 * byte. A read is capped well below what the file keeps, so it never reaches
 * for a byte that has been dropped.
 */
import { closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { debugLog } from "../../debug";
import { killProcessTree, killTrackedDetachedChildren, sanitizeBinaryOutput, untrackDetachedChildPid } from "./shell";
import { MAX_LOG_BYTES, compactLog, pruneShellLogs, shellLogRoot } from "./shell-logs";

/** Live shells per session. Beyond this, starting another is refused — the cap
 * replaces the timeout as the thing that stops a runaway from accumulating. */
export const MAX_BACKGROUND_SHELLS = 8;

/** Cap on one `shells` read. Older unread output is dropped, newest kept: a
 * poll is asking "what happened lately", and the log file has the rest. */
export const MAX_READ_BYTES = 50_000;

/** Rows kept in memory for the panel's one-line preview. */
const PREVIEW_LINES = 3;

export type ShellStatus = "running" | "exited" | "killed" | "failed";

/** The serializable half — what the tool, the panel and the RPC layer see. */
export interface ShellInfo {
    id: string;
    command: string;
    cwd: string;
    pid: number | undefined;
    status: ShellStatus;
    exitCode: number | null;
    startedAt: number;
    endedAt: number | null;
    logPath: string;
    /** Bytes written to the log so far. */
    bytes: number;
    /** Bytes already handed to the model, so `shells` can report "unread". */
    cursor: number;
    /** Last few output lines, for the panel. Never the whole stream. */
    preview: string[];
    /** True when the run started in the foreground and was promoted. */
    promoted: boolean;
}

interface ShellRecord extends ShellInfo {
    child: ChildProcess;
    /** Open fd for the log, or undefined when it could not be written. */
    fd: number | undefined;
    /** Offset of the log file's first byte in the shell's whole output. */
    logStart: number;
    /**
     * The shell's pipes are still open. They outlive it when it leaves a
     * process behind (`server &`), which is why its process group can only be
     * trusted to exist, and be killed, until they close.
     */
    outputOpen: boolean;
    /** Exit not yet reported to the model (see takeShellNotices). */
    noticePending: boolean;
    /** Set by killShell, so the exit handler can tell a kill from a crash. */
    killRequested: boolean;
    /** Throttle for output-driven repaints (see write). */
    lastEmitAt: number;
}

interface SessionShells {
    counter: number;
    byId: Map<string, ShellRecord>;
}

const sessions = new Map<string, SessionShells>();
type Listener = (info: ShellInfo) => void;
const listeners = new Set<Listener>();

/** Sessions are keyed by id; an absent id (print mode, one-shot runs) shares
 * one slate, which is correct because that process has one session anyway. */
const SHARED = "__shared__";

function bucket(sessionId: string | undefined): SessionShells {
    const key = sessionId ?? SHARED;
    let s = sessions.get(key);
    if (!s) {
        s = { counter: 0, byId: new Map() };
        sessions.set(key, s);
    }
    return s;
}

/** Filesystem-safe directory component for a session id. */
function slug(sessionId: string | undefined): string {
    return (sessionId ?? SHARED).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function logDir(sessionId: string | undefined): string {
    return join(shellLogRoot(), slug(sessionId));
}

/**
 * Whether a surface is showing running shells. Promotion-on-timeout is gated
 * on this: the timeout exists to stop an INVISIBLE long run, so it may only be
 * relaxed where the shells panel makes the run visible. Print mode and RPC
 * leave it false and keep killing on timeout until they grow a panel of their
 * own.
 */
let panelPresent = false;
export function setShellPanelPresent(present: boolean): void {
    panelPresent = present;
}
export function isShellPanelPresent(): boolean {
    return panelPresent;
}

/** Subscribe to status changes (start, exit, kill). Returns an unsubscribe. */
export function onShellChange(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit(rec: ShellRecord): void {
    const info = toInfo(rec);
    for (const fn of listeners) {
        try {
            fn(info);
        } catch (err) {
            debugLog("shells", "listener threw:", err as Error);
        }
    }
}

function toInfo(rec: ShellRecord): ShellInfo {
    const {
        child: _child,
        fd: _fd,
        logStart: _l,
        outputOpen: _o,
        noticePending: _n,
        killRequested: _k,
        lastEmitAt: _e,
        ...info
    } = rec;
    return { ...info, preview: [...rec.preview] };
}

function pushPreview(rec: ShellRecord, chunk: string): void {
    const text = sanitizeBinaryOutput(chunk);
    if (!text) return;
    const lines = text.split("\n");
    // The first piece continues whatever line was open; the rest are new.
    const last = rec.preview.length > 0 ? (rec.preview.pop() ?? "") : "";
    rec.preview.push(last + lines[0]);
    for (const line of lines.slice(1)) rec.preview.push(line);
    while (rec.preview.length > PREVIEW_LINES) rec.preview.shift();
}

export interface StartShellOptions {
    sessionId?: string;
    command: string;
    cwd: string;
    child: ChildProcess;
    /** Output already collected in the foreground, replayed into the log so a
     * promoted run keeps the lines it printed before promotion. */
    seed?: string;
    promoted?: boolean;
}

let exitCleanupInstalled = false;

/**
 * Kill everything bash started when the process exits, however it exits.
 *
 * Each surface calls killAllBashChildren on its own way out, but the TUI
 * leaves on SIGHUP/SIGTERM (closing the terminal tab) through process.exit in
 * its signal handler, which never reaches that path — and the children are
 * detached into their own process groups, so nothing else takes them down. A
 * `bun run dev` started in a tab that was then closed ran on under pid 1.
 * process.exit still fires "exit", and every kill here is synchronous.
 */
export function ensureExitCleanup(): void {
    if (exitCleanupInstalled) return;
    exitCleanupInstalled = true;
    process.once("exit", () => {
        killAllBashChildren();
    });
}

/** Register a spawned child as a background shell and start logging it. */
export function registerShell(opts: StartShellOptions): ShellInfo {
    ensureExitCleanup();
    pruneShellLogs();
    const b = bucket(opts.sessionId);
    const id = `bash_${++b.counter}`;
    const dir = logDir(opts.sessionId);
    let fd: number | undefined;
    let logPath = join(dir, `${id}.log`);
    try {
        mkdirSync(dir, { recursive: true });
        // "w" truncates: byte offsets are the whole read model, and a log left
        // over from a previous process (a resumed session reusing its id)
        // would put every offset in this run past somebody else's output.
        fd = openSync(logPath, "w");
    } catch (err) {
        // A log we cannot write is a degradation, not a failure: the shell
        // still runs and the panel still shows it; reads come back empty.
        debugLog("shells", `could not open log for ${id}:`, err as Error);
        logPath = "";
    }

    const rec: ShellRecord = {
        id,
        command: opts.command,
        cwd: opts.cwd,
        pid: opts.child.pid,
        status: "running",
        exitCode: null,
        startedAt: Date.now(),
        endedAt: null,
        logPath,
        bytes: 0,
        cursor: 0,
        preview: [],
        promoted: opts.promoted === true,
        child: opts.child,
        fd,
        logStart: 0,
        outputOpen: true,
        noticePending: false,
        killRequested: false,
        lastEmitAt: 0,
    };
    b.byId.set(id, rec);

    if (opts.seed) write(rec, Buffer.from(opts.seed, "utf-8"));
    opts.child.stdout?.on("data", (d: Buffer) => write(rec, d));
    opts.child.stderr?.on("data", (d: Buffer) => write(rec, d));

    const settle = (status: ShellStatus, code: number | null) => {
        if (rec.status !== "running") return;
        rec.status = status;
        rec.exitCode = code;
        rec.endedAt = Date.now();
        rec.noticePending = true;
        emit(rec);
    };
    opts.child.on("exit", (code, signal) => {
        // A killed shell reports as killed even though the OS calls it a
        // signal exit — the distinction is what the user did, not how.
        settle(rec.status === "running" && signal && rec.killRequested ? "killed" : "exited", code);
    });
    opts.child.on("error", (err) => {
        debugLog("shells", `${id} failed:`, err);
        settle("failed", null);
        releaseOutput(rec);
    });
    // Not on exit: whatever the shell left behind is still writing, and still ours to kill.
    opts.child.on("close", () => releaseOutput(rec));

    emit(rec);
    // A promoted child can be handed over after its `exit` already fired (the
    // foreground waits a moment for its pipes to close). No exit event is
    // coming, so settle from the child, or it reads "running" for good.
    if (opts.child.exitCode !== null || opts.child.signalCode) settle("exited", opts.child.exitCode);
    return toInfo(rec);
}

/**
 * Repaints are throttled, not per-chunk: a dev server can emit thousands of
 * lines a second and each one would otherwise ask the TUI to redraw. The
 * counters and the log are always exact — only the panel's view of them lags,
 * by at most PREVIEW_EMIT_MS.
 */
const PREVIEW_EMIT_MS = 400;

function closeLog(rec: ShellRecord): void {
    if (rec.fd === undefined) return;
    try {
        closeSync(rec.fd);
    } catch (err) {
        debugLog("shells", `closing log for ${rec.id} failed:`, err as Error);
    }
    rec.fd = undefined;
}

/** Nothing more can arrive: the log closes, and the pid stops being ours. */
function releaseOutput(rec: ShellRecord): void {
    rec.outputOpen = false;
    closeLog(rec);
    if (rec.pid) untrackDetachedChildPid(rec.pid);
}

function appendToLog(rec: ShellRecord, data: Buffer): void {
    if (rec.fd === undefined) return;
    try {
        // Counted only once the bytes are actually on disk, so a read can never
        // be pointed at output that is not there yet.
        rec.bytes += writeSync(rec.fd, data);
        if (rec.bytes - rec.logStart > MAX_LOG_BYTES) {
            const compacted = compactLog(rec.logPath, rec.fd, rec.bytes - rec.logStart);
            rec.fd = compacted.fd;
            rec.logStart = rec.bytes - compacted.kept;
        }
    } catch (err) {
        debugLog("shells", `log write failed for ${rec.id}:`, err as Error);
        closeLog(rec);
    }
}

function write(rec: ShellRecord, data: Buffer): void {
    pushPreview(rec, data.toString("utf-8"));
    appendToLog(rec, data);
    const now = Date.now();
    if (now - rec.lastEmitAt >= PREVIEW_EMIT_MS) {
        rec.lastEmitAt = now;
        emit(rec);
    }
}

export function listShells(sessionId: string | undefined): ShellInfo[] {
    return [...bucket(sessionId).byId.values()].map(toInfo);
}

export function runningShellCount(sessionId: string | undefined): number {
    let n = 0;
    for (const rec of bucket(sessionId).byId.values()) if (rec.status === "running") n++;
    return n;
}

export interface ShellReadResult {
    info: ShellInfo;
    /** Output since the last read (or since `from`), newest-first-truncated. */
    text: string;
    /** Bytes skipped because the unread span exceeded MAX_READ_BYTES. */
    skippedBytes: number;
    /** Lines dropped by `filter`, so a silent empty read is explainable. */
    filteredOut: number;
}

/**
 * Read output since the cursor and advance it. Repeated calls return only what
 * is new — which is the whole point: polling a dev server should not re-read
 * its startup banner every time.
 */
export function readShell(
    sessionId: string | undefined,
    id: string,
    opts: { filter?: string; advance?: boolean } = {},
): ShellReadResult | undefined {
    const rec = bucket(sessionId).byId.get(id);
    if (!rec) return undefined;

    const end = rec.bytes;
    let start = rec.cursor;
    let skippedBytes = 0;
    if (end - start > MAX_READ_BYTES) {
        skippedBytes = end - start - MAX_READ_BYTES;
        start = end - MAX_READ_BYTES;
    }

    let text = "";
    if (rec.logPath && end > start) {
        // `bytes` only counts what writeSync accepted, so the span is always
        // really on disk — no flush to wait for, nothing to clamp against.
        try {
            const rfd = openSync(rec.logPath, "r");
            try {
                const buf = Buffer.alloc(end - start);
                const read = readSync(rfd, buf, 0, end - start, start - rec.logStart);
                text = sanitizeBinaryOutput(buf.subarray(0, read).toString("utf-8"));
            } finally {
                closeSync(rfd);
            }
        } catch (err) {
            debugLog("shells", `read failed for ${id}:`, err as Error);
        }
    }

    let filteredOut = 0;
    if (opts.filter && text) {
        let re: RegExp | undefined;
        try {
            re = new RegExp(opts.filter);
        } catch {
            re = undefined; // an unparseable filter is ignored, not fatal
        }
        if (re) {
            const lines = text.split("\n");
            const kept = lines.filter((l) => re.test(l));
            filteredOut = lines.length - kept.length;
            text = kept.join("\n");
        }
    }

    if (opts.advance !== false) rec.cursor = end;
    return { info: toInfo(rec), text, skippedBytes, filteredOut };
}

export function killShell(sessionId: string | undefined, id: string): ShellInfo | undefined {
    const rec = bucket(sessionId).byId.get(id);
    if (!rec) return undefined;
    // An exited shell can still have left processes behind: the tree goes either way.
    if (rec.outputOpen && rec.pid) killProcessTree(rec.pid);
    if (rec.status === "running") {
        rec.killRequested = true;
        // The exit handler settles status; if the child is already gone and no
        // exit fires, mark it here so the entry can't sit "running" forever.
        if (rec.child.exitCode !== null || rec.child.signalCode) {
            rec.status = "killed";
            rec.endedAt = Date.now();
            releaseOutput(rec);
            emit(rec);
        }
    }
    return toInfo(rec);
}

/**
 * Exits the model has not been told about yet, cleared as they are taken. The
 * turn's prepareStep seam calls this to inject an ephemeral reminder, so a
 * finished shell announces itself instead of waiting to be polled — opencode's
 * tool description puts it well: "DO NOT poll its progress."
 */
export function takeShellNotices(sessionId: string | undefined): ShellInfo[] {
    const out: ShellInfo[] = [];
    for (const rec of bucket(sessionId).byId.values()) {
        if (rec.noticePending) {
            rec.noticePending = false;
            out.push(toInfo(rec));
        }
    }
    return out;
}

/** Kill every shell in one session, and what any of them left behind. Returns how many were running. */
export function killSessionShells(sessionId: string | undefined): number {
    const b = bucket(sessionId);
    let killed = 0;
    for (const rec of b.byId.values()) {
        if (rec.status === "running") killed++;
        if (rec.status === "running" || rec.outputOpen) killShell(sessionId, rec.id);
    }
    return killed;
}

/**
 * A session now exists where there was none: it takes the shells started
 * before it did (`/shells run` ahead of the first message), or they would sit
 * in the shared slate where neither `/shells` nor the agent looks any more.
 * The shared counter is left alone: an adopted shell keeps its log, and a new
 * shell there must not reuse that file.
 */
export function adoptSharedShells(sessionId: string): void {
    const shared = sessions.get(SHARED);
    if (!shared) return;
    const b = bucket(sessionId);
    for (const rec of shared.byId.values()) {
        rec.id = `bash_${++b.counter}`;
        b.byId.set(rec.id, rec);
        emit(rec);
    }
    shared.byId.clear();
}

/** Kill everything, everywhere — the process is going away. */
export function killAllShells(): number {
    let killed = 0;
    for (const key of sessions.keys()) killed += killSessionShells(key === SHARED ? undefined : key);
    return killed;
}

/**
 * Everything bash started, on the way out: background shells plus the detached
 * foreground strays. Returns the number of shells killed, which is what a
 * surface prints — the strays are invisible by definition and not counted.
 *
 * This exists because the leak it fixes was surface-by-surface. Shells are
 * process-lifetime BY DESIGN — nothing is persisted, and a resumed session
 * does not adopt the previous process's children — so a surface that exits
 * without calling this strands processes nobody can see, read or kill. The CLI
 * made both calls; `loop serve`, `loop rpc`, print mode and the desktop made
 * neither. Every surface that can run a turn owes this call on its exit path,
 * and there is now one call to owe rather than two to remember.
 */
export function killAllBashChildren(): number {
    const killed = killAllShells();
    killTrackedDetachedChildren();
    return killed;
}

/** Compact elapsed time for a status line: 8s, 2m14s, 1h03m. */
export function formatDuration(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total}s`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Test seam: drop all state without killing (the fixtures own their pids). */
export function resetShellRegistry(): void {
    sessions.clear();
    listeners.clear();
}
