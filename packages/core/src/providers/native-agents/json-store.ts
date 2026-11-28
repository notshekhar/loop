import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The small JSON files the native agents keep in loop's home (session links,
 * probe results). Every loop process on the machine — two terminals, the
 * desktop app, a `loop run` — reads and writes the same file, so a write must
 * start from what is on disk NOW, not from a copy this process loaded earlier:
 * writing back a stale copy silently drops whatever the other processes added.
 */

/** The file's object, or `{}` when it is missing or unreadable. */
export function readJsonFile<T extends object>(path: string): T {
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return (value && typeof value === "object" ? value : {}) as T;
    } catch {
        return {} as T;
    }
}

/**
 * Read the file fresh, apply `update`, and replace it atomically (temp file +
 * rename, so a reader never sees half a file). Returns the written value; a
 * failed write is swallowed — these files are caches, losing one write only
 * costs a re-probe or a re-seed.
 */
export function updateJsonFile<T extends object>(path: string, update: (current: T) => T, opts: { mode?: number } = {}): T {
    const next = update(readJsonFile<T>(path));
    try {
        const dir = dirname(path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(next, null, 2), opts.mode === undefined ? undefined : { mode: opts.mode });
        renameSync(tmp, path);
    } catch {
        /* cache only */
    }
    return next;
}
