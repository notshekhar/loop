/**
 * Background shell logs on disk: where they live, and what keeps them from
 * growing for good. A dev server left running can print for days, and nothing
 * ever reads a log from a process that has gone (shell-registry.ts: a resumed
 * session does not adopt old shells).
 */
import { closeSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../brand";
import { debugLog } from "../../debug";

/** The most one log may hold on disk. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;

/**
 * What a log keeps when it reaches the cap. Far more than one `shells` read
 * (MAX_READ_BYTES), so a read never reaches past it; a quarter of the cap, so
 * the copy happens once per 24 MB of output rather than on every write.
 */
export const KEPT_LOG_BYTES = 8 * 1024 * 1024;

/** How long a session's logs stay after their last write. */
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let rootForTests: string | null = null;
let pruned = false;

export function shellLogRoot(): string {
    return rootForTests ?? join(getConfigDir(), "shells");
}

/**
 * Tests only: keep logs out of the real home. Setting HOME does not do it —
 * Bun's homedir() ignores changes to it at runtime.
 */
export function setShellLogRootForTests(root: string | null): void {
    rootForTests = root;
    pruned = false;
}

/** Cut a log down to its newest bytes. Closes `fd`; returns the new one and how many bytes stayed. */
export function compactLog(path: string, fd: number, size: number): { fd: number; kept: number } {
    const kept = Math.min(KEPT_LOG_BYTES, size);
    const tail = Buffer.alloc(kept);
    const reader = openSync(path, "r");
    try {
        readSync(reader, tail, 0, kept, size - kept);
    } finally {
        closeSync(reader);
    }
    closeSync(fd);
    writeFileSync(path, tail);
    return { fd: openSync(path, "a"), kept };
}

function lastWrite(dir: string): number {
    const times = readdirSync(dir).map((name) => statSync(join(dir, name)).mtimeMs);
    return Math.max(statSync(dir).mtimeMs, ...times);
}

/**
 * Delete sessions' logs nothing has written to for LOG_RETENTION_MS. Once per
 * process, on its first shell: before that this process has none of its own to
 * lose, and a shell another process still runs quietly only loses its log file.
 */
export function pruneShellLogs(now = Date.now()): void {
    if (pruned) return;
    pruned = true;
    const root = shellLogRoot();
    try {
        for (const name of readdirSync(root)) {
            const dir = join(root, name);
            if (now - lastWrite(dir) > LOG_RETENTION_MS) rmSync(dir, { recursive: true, force: true });
        }
    } catch (err) {
        debugLog("shells", "pruning old logs failed:", err as Error);
    }
}
