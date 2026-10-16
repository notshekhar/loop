/**
 * Read-through cache for the small text files every turn re-reads to build its
 * system prompt (AGENTS.md / CLAUDE.md, skill files, the MEMORY.md index).
 *
 * One stat per call instead of exists + stat + read: when the file's mtime and
 * size are unchanged, the cached text comes back as-is. An edit always lands —
 * it moves the mtime — so the prompt stays exactly what reading the disk would
 * give, just without the reads.
 */
import { readFileSync, statSync } from "node:fs";

const cache = new Map<string, { mtimeMs: number; size: number; text: string }>();

/** The file's text, or null when it is missing or not a regular file. Throws only on a failed read. */
export function readTextCached(path: string): string | null {
    let st;
    try {
        st = statSync(path);
    } catch {
        cache.delete(path);
        return null;
    }
    if (!st.isFile()) {
        cache.delete(path);
        return null;
    }
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = readFileSync(path, "utf8");
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
}
