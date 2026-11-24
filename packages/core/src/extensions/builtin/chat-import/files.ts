/**
 * Reading other agents' files without ever changing them: JSONL transcripts,
 * the first part of a large one, and SQLite databases another program owns.
 */
import { closeSync, constants, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDatabase } from "../../../sessions/sqlite";

/** Every parseable line of a JSONL file; a torn last line (the agent still writing) is skipped. */
export function readJsonl(path: string): unknown[] {
    return parseJsonLines(readFileSync(path, "utf8"));
}

/**
 * The parseable lines in the first `bytes` of a file — enough to read a chat's
 * header and first prompt without loading a transcript that may be hundreds
 * of megabytes, when all a picker needs is its title.
 */
export function readJsonlHead(path: string, bytes = 256 * 1024): unknown[] {
    const fd = openSync(path, "r");
    try {
        const buffer = Buffer.alloc(bytes);
        const read = readSync(fd, buffer, 0, bytes, 0);
        return parseJsonLines(buffer.subarray(0, read).toString("utf8"));
    } finally {
        closeSync(fd);
    }
}

function parseJsonLines(text: string): unknown[] {
    const out: unknown[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line));
        } catch {
            // A partial line is the one being written right now, or the cut of readJsonlHead.
        }
    }
    return out;
}

/**
 * Run `use` against another program's SQLite database without leaving a trace.
 *
 * A database in WAL mode cannot be opened read-only cleanly: SQLite creates a
 * `-shm` file beside it (a write into the other program's folder), and fails
 * outright when it cannot — which is how Cursor leaves most of its chat
 * stores. So a WAL database is read through a copy of itself and its WAL (the
 * WAL holds the newest messages); the copy is a clone on filesystems that
 * support one, so even a large database costs nothing to copy. Any other
 * database is opened read-only in place.
 */
export function withForeignSqlite<T>(path: string, use: (db: SqliteDatabase) => T): T {
    if (isWalDatabase(path)) return withCopy(path, use);
    return useAndClose(openSqlite(path, { readonly: true }), use);
}

/** Bytes 18 and 19 of an SQLite header are 2 when the database is in WAL mode. */
function isWalDatabase(path: string): boolean {
    const fd = openSync(path, "r");
    try {
        const header = Buffer.alloc(20);
        readSync(fd, header, 0, 20, 0);
        return header[18] === 2 && header[19] === 2;
    } finally {
        closeSync(fd);
    }
}

function withCopy<T>(path: string, use: (db: SqliteDatabase) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "loop-import-"));
    try {
        const copy = join(dir, "chat.db");
        copyFileSync(path, copy, constants.COPYFILE_FICLONE);
        if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`, constants.COPYFILE_FICLONE);
        return useAndClose(openSqlite(copy, { create: false }), use);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function useAndClose<T>(db: SqliteDatabase, use: (db: SqliteDatabase) => T): T {
    try {
        return use(db);
    } finally {
        db.close();
    }
}
