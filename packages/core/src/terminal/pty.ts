/**
 * A pseudo-terminal, built on `openpty(3)` through `bun:ffi`.
 *
 * node-pty is not an option: under Bun its libuv socket pump never fires, so
 * data and exit events simply never arrive. (The desktop app can use it because
 * that runs on Electron/Node; the CLI cannot.) Everything here is shaped by
 * that constraint and by three further Bun facts, each marked at its site.
 */
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

/** `struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; }` */
function winsize(rows: number, cols: number): Uint16Array {
    return new Uint16Array([Math.max(1, rows), Math.max(1, cols), 0, 0]);
}

/**
 * The winsize ioctls, which are NOT the same number on every platform.
 *
 * BSD (macOS included) encodes direction and struct size into the request:
 * _IOR('t', 104, struct winsize) and _IOW('t', 103, …). Linux uses small fixed
 * constants instead. Getting this wrong is silent — the call still returns 0,
 * it just acts on nothing — so a terminal keeps wrapping at its old width with
 * no error anywhere.
 */
const LINUX = process.platform === "linux";
const TIOCGWINSZ = LINUX ? 0x5413n : 0x40087468n;
const TIOCSWINSZ = LINUX ? 0x5414n : 0x80087467n;

type PtyLib = {
    openpty(amaster: unknown, aslave: unknown, name: unknown, termp: unknown, winp: unknown): number;
    ioctl(fd: number, request: bigint, arg: unknown): number;
    ioctlPadded(fd: number, request: bigint, ...rest: unknown[]): number;
    poll(fds: unknown, nfds: bigint, timeout: number): number;
    read(fd: number, buf: unknown, count: bigint): bigint;
    write(fd: number, buf: unknown, count: bigint): bigint;
    close(fd: number): number;
};

/** poll(2) readiness bit, and how often we look for output. */
const POLLIN = 1;
const READ_INTERVAL_MS = 8;
const READ_BUFFER_BYTES = 65536;

let lib: PtyLib | undefined;
let libError: string | undefined;

/**
 * `openpty` lives in libutil on Linux and in libSystem on macOS.
 */
function libCandidates(): string[] {
    if (process.platform === "darwin") return ["libSystem.B.dylib"];
    return [`libutil.${suffix}.1`, `libutil.${suffix}`, `libc.${suffix}.6`];
}

const IOCTL_PLAIN = [FFIType.int, FFIType.u64, FFIType.ptr] as const;
/**
 * `ioctl` is variadic, and on Apple arm64 every variadic argument is passed on
 * the STACK while bun:ffi passes declared arguments in registers — so the plain
 * three-argument form hands the callee a garbage pointer. It still returns 0,
 * which is the dangerous part: a resize silently does nothing.
 *
 * Declaring eight leading arguments pushes the ninth onto the stack, exactly
 * where the callee looks for the first variadic one. Other ABIs (x86-64, Linux
 * arm64) pass variadic arguments in registers and want the plain form, so which
 * one is correct is decided by probing rather than by guessing the platform.
 */
const IOCTL_PADDED = [
    FFIType.int,
    FFIType.u64,
    FFIType.i64,
    FFIType.i64,
    FFIType.i64,
    FFIType.i64,
    FFIType.i64,
    FFIType.i64,
    FFIType.ptr,
] as const;

function loadLib(): PtyLib | undefined {
    if (lib || libError) return lib;
    for (const name of libCandidates()) {
        try {
            const plain = dlopen(name, {
                openpty: {
                    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
                    returns: FFIType.int,
                },
                ioctl: { args: IOCTL_PLAIN as never, returns: FFIType.int },
                poll: { args: [FFIType.ptr, FFIType.u64, FFIType.int], returns: FFIType.int },
                read: { args: [FFIType.int, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
                write: { args: [FFIType.int, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
                close: { args: [FFIType.int], returns: FFIType.int },
            });
            const padded = dlopen(name, { ioctl: { args: IOCTL_PADDED as never, returns: FFIType.int } });
            lib = {
                openpty: plain.symbols.openpty as PtyLib["openpty"],
                ioctl: plain.symbols.ioctl as PtyLib["ioctl"],
                ioctlPadded: padded.symbols.ioctl as PtyLib["ioctlPadded"],
                poll: plain.symbols.poll as PtyLib["poll"],
                read: plain.symbols.read as PtyLib["read"],
                write: plain.symbols.write as PtyLib["write"],
                close: plain.symbols.close as PtyLib["close"],
            };
            return lib;
        } catch {
            // try the next candidate
        }
    }
    libError = `openpty not available (tried ${libCandidates().join(", ")})`;
    return undefined;
}

/** Which ioctl calling form actually works here; decided once, by experiment. */
let paddedIoctl: boolean | undefined;

function callIoctl(l: PtyLib, fd: number, request: bigint, arg: Uint16Array): number {
    const Z = 0n;
    return paddedIoctl ? l.ioctlPadded(fd, request, Z, Z, Z, Z, Z, Z, ptr(arg)) : l.ioctl(fd, request, ptr(arg));
}

/**
 * Decide the ioctl form by round-tripping a real winsize through a throwaway
 * pty: set a size, read it back, and keep whichever form returns what it wrote.
 * Guessing from `process.arch` would be a guess about a calling convention,
 * which is precisely the thing that already failed silently once.
 */
function probeIoctlForm(l: PtyLib): void {
    if (paddedIoctl !== undefined) return;
    const master = new Int32Array(1);
    const slave = new Int32Array(1);
    if (l.openpty(ptr(master), ptr(slave), null, null, ptr(winsize(24, 80))) !== 0) {
        paddedIoctl = process.platform === "darwin" && process.arch === "arm64";
        return;
    }
    try {
        for (const padded of [false, true]) {
            paddedIoctl = padded;
            callIoctl(l, master[0], TIOCSWINSZ, winsize(41, 121));
            const back = new Uint16Array(4);
            callIoctl(l, master[0], TIOCGWINSZ, back);
            if (back[0] === 41 && back[1] === 121) return;
        }
        paddedIoctl = false;
    } finally {
        l.close(master[0]);
        l.close(slave[0]);
    }
}

export interface PtyOptions {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    rows?: number;
    cols?: number;
}

export interface Pty {
    write(data: string): void;
    resize(rows: number, cols: number): void;
    kill(): void;
    readonly exited: boolean;
    onData(fn: (chunk: string) => void): void;
    onExit(fn: (code: number) => void): void;
}

export function ptyAvailable(): boolean {
    return loadLib() !== undefined;
}

export function ptyUnavailableReason(): string | undefined {
    loadLib();
    return libError;
}

export function spawnPty(options: PtyOptions): Pty {
    const l = loadLib();
    if (!l) throw new Error(libError ?? "openpty not available");
    probeIoctlForm(l);

    const master = new Int32Array(1);
    const slave = new Int32Array(1);
    const rows = options.rows ?? 24;
    const cols = options.cols ?? 80;
    // The initial size rides on openpty's winsize argument, which is a normal
    // (non-variadic) parameter and so is always passed correctly.
    if (l.openpty(ptr(master), ptr(slave), null, null, ptr(winsize(rows, cols))) !== 0) {
        throw new Error("openpty failed");
    }
    const masterFd = master[0];
    const slaveFd = slave[0];

    const dataFns: ((chunk: string) => void)[] = [];
    const exitFns: ((code: number) => void)[] = [];
    let exited = false;
    let released = false;

    const child = Bun.spawn([options.cmd, ...(options.args ?? [])], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, TERM: options.env?.TERM ?? "xterm-256color" },
        stdio: [slaveFd as never, slaveFd as never, slaveFd as never],
        onExit(_proc, code) {
            if (exited) return;
            exited = true;
            // The fds are NOT released here: the child's last writes can still
            // be sitting in the pty buffer unread, and closing the master now
            // would drop the final frames. Polling continues until the owner
            // calls kill().
            for (const fn of exitFns) fn(code ?? 0);
        },
    });

    // The parent's copy of the slave is closed as soon as the child has it.
    // Holding it open means the master never sees EOF when the child exits.
    l.close(slaveFd);

    /**
     * Output is polled, not streamed.
     *
     * The obvious implementation — a node:fs read stream on the master — works
     * for exactly one terminal. A read on a pty master blocks until the child
     * writes something, and libuv serves those from a fixed threadpool of four,
     * so each open terminal permanently occupies a thread and the third or
     * fourth one silently receives nothing. (`net.Socket` on the fd, the usual
     * way around this, delivers no data at all under Bun.)
     *
     * So: ask poll(2) whether there is anything to read, and only then read,
     * which never blocks and holds no thread. The interval yields to the event
     * loop between passes, which is what keeps this from starving the app's own
     * stdin the way a tight FFI read loop would.
     */
    const pollFd = new Int32Array(2); // struct pollfd { int fd; short events; short revents; }
    const readBuf = Buffer.alloc(READ_BUFFER_BYTES);
    /**
     * One decoder for the whole stream, not one per read.
     *
     * A read returns whatever bytes are in the pty buffer, which is a byte
     * count and not a character boundary — so a multi-byte character straddles
     * two reads whenever one ends mid-sequence. Decoding each read on its own
     * turns that character into U+FFFD and loses it permanently; `stream: true`
     * holds the partial sequence back and finishes it with the next read. The
     * symptom is a lone replacement character in the middle of an otherwise
     * perfect line — box drawing and emoji are what usually show it.
     */
    const decoder = new TextDecoder("utf-8");
    const pump = setInterval(() => {
        // Drain what is ready, but bounded: a chatty child must not keep the
        // loop here indefinitely and stall rendering.
        for (let i = 0; i < 32; i++) {
            pollFd[0] = masterFd;
            pollFd[1] = POLLIN;
            if (l.poll(ptr(pollFd), 1n, 0) <= 0) break;
            const n = Number(l.read(masterFd, ptr(readBuf), BigInt(READ_BUFFER_BYTES)));
            if (n <= 0) break; // EOF, or EAGAIN on a spurious wakeup
            const text = decoder.decode(readBuf.subarray(0, n), { stream: true });
            if (!text) continue; // the read ended mid-character; it lands with the next one
            for (const fn of dataFns) fn(text);
        }
    }, READ_INTERVAL_MS);

    /**
     * Stop polling BEFORE closing the fd: reads are synchronous and only happen
     * inside the timer, so once it is cleared nothing can touch the descriptor
     * and closing it is safe. Idempotent — both exit paths lead here.
     */
    const release = () => {
        if (released) return;
        released = true;
        clearInterval(pump);
        l.close(masterFd);
    };

    return {
        write(data: string) {
            if (exited) return;
            // Synchronous, so writes cannot reorder — the async fs.write path
            // this replaces could deliver "echo" as "ech" + "o". Partial writes
            // are looped over rather than assumed away.
            const buf = Buffer.from(data, "utf8");
            let off = 0;
            while (off < buf.length) {
                const n = Number(l.write(masterFd, ptr(buf.subarray(off)), BigInt(buf.length - off)));
                if (n <= 0) break; // pty gone, or would block; drop the rest
                off += n;
            }
        },
        resize(r: number, c: number) {
            if (exited) return;
            callIoctl(l, masterFd, TIOCSWINSZ, winsize(r, c));
        },
        kill() {
            if (!exited) {
                exited = true;
                try {
                    child.kill();
                } catch {
                    // already gone
                }
            }
            // Releasing is separate from exiting, and unconditional, because a
            // child that ended on its own has already set `exited` — an early
            // return here left the poll timer running on a closed pty forever,
            // holding both the interval and the master fd for the life of the
            // process. Nothing else releases them, so every shell that exited
            // by itself leaked one of each.
            release();
        },
        get exited() {
            return exited;
        },
        onData(fn) {
            dataFns.push(fn);
        },
        onExit(fn) {
            exitFns.push(fn);
        },
    };
}
