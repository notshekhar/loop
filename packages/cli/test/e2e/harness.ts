/**
 * A loop TUI test harness that cannot lie.
 *
 * Driving a TUI from a test is easy to do badly, and a harness that measures the
 * wrong thing is worse than no harness — it reports success. Three specific ways
 * that happened while this suite was being written, each closed here:
 *
 *   * shared state — a HOME reused across runs meant one run's agent.db (and one
 *     run's surviving process) decided the next run's behaviour. Every session
 *     gets its own mkdtemp HOME, thrown away after.
 *   * stray processes — a pattern kill reaped things it did not spawn. Nothing
 *     here kills by pattern: the pty owns its child and only that child is ever
 *     signalled.
 *   * a terminal that does not answer — loop probes the terminal (CPR for width
 *     calibration, DA, cell size, background colour) and falls back on a timeout
 *     when nothing replies, so a dumb pipe measures the FALLBACK path, not the
 *     one users run. The emulator here consumes the output stream and answers
 *     the probes from its own cursor, the way a real emulator does.
 *
 * Screens come back from that same emulator model, so what is asserted is what a
 * terminal would actually show.
 *
 * Two choices are worth knowing about:
 *
 *   The pty is loop's own `spawnPty` (openpty(3) through bun:ffi), not node-pty,
 *   for the reason documented there: under Bun node-pty's libuv socket pump
 *   never fires, so data and exit events never arrive. Using loop's own means
 *   the harness inherits the ioctl-ABI and poll-instead-of-read fixes rather
 *   than rediscovering them.
 *
 *   The alternate-screen switch is filtered out of the stream before the
 *   emulator sees it (see ALT_SCREEN). That keeps "committed rows" meaning what
 *   the assertions were written to mean.
 */
import { Terminal } from "@xterm/headless";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnPty, type Pty } from "../../../core/src/terminal/pty";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const CLI = join(REPO, "packages", "cli", "src", "cli.ts");

// Probes loop sends that a real terminal answers. Left unanswered they each
// cost a timeout and push loop down a fallback path.
const CPR = /\x1b\[6n/g;
const DA = /\x1b\[c/;
const CELL_SIZE = /\x1b\[16t/;
const KITTY_QUERY = /\x1b\[\?u/;
const OSC_BG = /\x1b\]11;\?(?:\x07|\x1b\\)/;

/**
 * The alternate-screen switch, removed before the emulator parses the stream.
 *
 * loop's chat runs on the alternate screen, and a full emulator implements that
 * faithfully: a second buffer with no scrollback of its own. That would make
 * every "nothing was committed to the scrollback" assertion in this suite
 * trivially true — the alt buffer cannot commit rows, so the check would pass
 * no matter what the renderer did, which is exactly the kind of harness that
 * reports success while measuring nothing.
 *
 * What those assertions are actually about is whether loop SCROLLED the
 * terminal — whether it pushed rows off the top, which is the one thing a
 * terminal will not let you take back. Keeping everything on one buffer is what
 * makes that observable, so the switch is dropped and `baseY` stays the honest
 * count of rows loop has pushed away.
 */
const ALT_SCREEN = /\x1b\[\?104[789][hl]/g;

/** Mouse-tracking toggles, read out of the raw stream rather than the screen. */
const MOUSE_MODE = /\x1b\[\?(?:1000|1002|1003|1006)([hl])/g;

export interface SessionOptions {
    settings?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    envExtra?: Record<string, string>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Session {
    readonly home: string;
    readonly project: string;
    cols: number;
    rows: number;
    raw = "";

    private term: Terminal;
    private pty: Pty;
    /** Chunks are consumed in order: the emulator must be current before a probe is answered. */
    private queue: Promise<void> = Promise.resolve();

    constructor(options: SessionOptions = {}) {
        const { settings = "{}", cols = 100, rows = 30, cwd, envExtra } = options;
        this.cols = cols;
        this.rows = rows;

        this.home = mkdtempSync(join(tmpdir(), "loop-harness-"));
        mkdirSync(join(this.home, ".loop", "agent"), { recursive: true });
        writeFileSync(join(this.home, ".loop", "settings.json"), settings);
        // A fresh empty project: trust is keyed per folder in SQLite and only
        // asked for when the folder ships .loop/.claude resources, so an empty
        // one opens with no modal eating the scripted keystrokes.
        this.project = cwd ?? mkdtempSync(join(tmpdir(), "loop-project-"));

        this.term = new Terminal({ cols, rows, scrollback: 4000, allowProposedApi: true });

        this.pty = spawnPty({
            cmd: "bun",
            args: [CLI],
            cwd: this.project,
            rows,
            cols,
            env: {
                HOME: this.home,
                TERM: "xterm-256color",
                COLUMNS: String(cols),
                LINES: String(rows),
                // spawnPty inherits process.env, so this is unset by emptying it
                // (the reader compares against "1").
                LOOP_SPAWN_BINARY: "",
                // 25 scenarios booting loop would otherwise chime 25 times, and
                // the bell fallback would land bytes in the stream we assert on.
                LOOP_SOUND: "0",
                ...envExtra,
            },
        });

        this.pty.onData((chunk) => {
            this.raw += chunk;
            this.queue = this.queue.then(() => this.consume(chunk));
        });
    }

    // -- the terminal side ------------------------------------------------
    private write(data: string): Promise<void> {
        return new Promise((resolve) => this.term.write(data, resolve));
    }

    private async consume(chunk: string): Promise<void> {
        await this.write(chunk.replace(ALT_SCREEN, ""));
        this.answerProbes(chunk);
    }

    /** Reply to what a real terminal would reply to. */
    private answerProbes(chunk: string): void {
        const cpr = chunk.match(CPR);
        if (cpr) {
            // The emulator has already consumed this chunk, so its cursor is
            // where the app's cursor is — which is the whole point of the probe.
            const b = this.term.buffer.active;
            for (let i = 0; i < cpr.length; i++) {
                this.pty.write(`\x1b[${b.cursorY + 1};${b.cursorX + 1}R`);
            }
        }
        if (CELL_SIZE.test(chunk)) this.pty.write("\x1b[6;17;8t"); // 17x8 px cells
        if (DA.test(chunk)) this.pty.write("\x1b[?62;c");
        if (KITTY_QUERY.test(chunk)) this.pty.write("\x1b[?0u"); // no kitty keyboard protocol
        if (OSC_BG.test(chunk)) this.pty.write("\x1b]11;rgb:1414/1414/1414\x1b\\");
    }

    async pump(seconds: number): Promise<void> {
        const end = Date.now() + seconds * 1000;
        while (Date.now() < end) await sleep(20);
        // Everything read so far is parsed before anything is asserted.
        await this.queue;
    }

    async send(data: string, settle = 0.9): Promise<void> {
        this.pty.write(data);
        await this.pump(settle);
    }

    async resize(cols: number, rows: number): Promise<void> {
        this.cols = cols;
        this.rows = rows;
        this.term.resize(cols, rows);
        this.pty.resize(rows, cols); // TIOCSWINSZ; the kernel raises SIGWINCH
    }

    /**
     * Whether the LAST thing loop said about mouse tracking was "on".
     *
     * The alternate screen has no terminal scrollback, so mouse reporting is
     * the whole of scrolling — and loop's own start-up cleanse of stale modes
     * runs after the alt screen asks for it, so "asked once" is not enough.
     * Reads what loop actually wrote, since this harness feeds wheel bytes in
     * regardless of whether a real terminal would have sent them.
     */
    mouseTrackingEnabled(): boolean {
        const toggles = [...this.raw.matchAll(MOUSE_MODE)];
        return toggles.length > 0 && toggles[toggles.length - 1]![1] === "h";
    }

    // -- what the user would see ------------------------------------------
    /** Rows scrolled off the top — the count a terminal will not give back. */
    committed(): number {
        return this.term.buffer.active.baseY;
    }

    screenRows(): string[] {
        const b = this.term.buffer.active;
        const out: string[] = [];
        for (let y = 0; y < this.rows; y++) {
            out.push((b.getLine(b.baseY + y)?.translateToString(true) ?? "").trimEnd());
        }
        return out;
    }

    /** Lines that have scrolled off the top — the terminal's scrollback. */
    historyRows(): string[] {
        const b = this.term.buffer.active;
        const out: string[] = [];
        for (let y = 0; y < b.baseY; y++) {
            out.push((b.getLine(y)?.translateToString(true) ?? "").trimEnd());
        }
        return out;
    }

    /** Viewport cells drawn in reverse video — how the panels draw a cursor. */
    inverseCells(): [number, number][] {
        const b = this.term.buffer.active;
        const found: [number, number][] = [];
        for (let y = 0; y < this.rows; y++) {
            const line = b.getLine(b.baseY + y);
            if (!line) continue;
            for (let x = 0; x < this.cols; x++) {
                if (line.getCell(x)?.isInverse()) found.push([y, x]);
            }
        }
        return found;
    }

    writeHome(relative: string, contents: string): void {
        const path = join(this.home, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
    }

    dump(label: string): void {
        console.log(`\n===== ${label} (scrollback ${this.committed()}) =====`);
        this.screenRows().forEach((line, i) => console.log(`${String(i).padStart(2)}|${line}`));
    }

    async close(): Promise<void> {
        if (!this.pty.exited) {
            this.pty.write("\x03\x03");
            await this.pump(0.6);
        }
        this.pty.kill();
        const deadline = Date.now() + 3000;
        while (!this.pty.exited && Date.now() < deadline) await sleep(50);
        this.term.dispose();
        rmSync(this.home, { recursive: true, force: true });
        rmSync(this.project, { recursive: true, force: true });
    }
}

/** `using` the session is what guarantees the child and the temp dirs go away. */
export async function withSession<T>(
    options: SessionOptions,
    body: (s: Session) => Promise<T>,
): Promise<T> {
    const s = new Session(options);
    try {
        return await body(s);
    } finally {
        await s.close();
    }
}
