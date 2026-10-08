import type { SqliteDatabase as Database } from "./sqlite";
import type { Entry, ProviderId, SessionInfoData } from "../types";
import { getDb } from "./db";
import { normalizeUsage } from "./usage";

/**
 * Prepared-statement layer over the session tables. Sessions and entries keep
 * their public identities (session ulid, 8-hex entry id) in pub_id columns;
 * the integer PKs never leave this file. Entry `payload` is the full entry
 * JSON and is the single source of truth — the usage/model columns are
 * derived at insert for aggregate queries and are never read back into an
 * Entry.
 */

/** Which side of the archive a listing wants. */
export type SessionScope = "active" | "archived" | "all";

export interface SessionRecord {
    rowId: number;
    info: SessionInfoData;
    name?: string;
    updatedAt: number;
    /** Payload JSON of the first user message, when requested by list(). */
    firstUserPayload?: string;
    /** Most recent model any entry recorded, when requested by list(). Absent
     * for a session that has never produced a billed entry. */
    lastModel?: string;
    /** Epoch ms the session was archived; absent while it is active. */
    archivedAt?: number;
}

interface SessionRow {
    id: number;
    pub_id: string;
    cwd: string;
    provider: string;
    model: string;
    name: string | null;
    parent_pub: string | null;
    created_at: number;
    updated_at: number;
    first_user_payload?: string | null;
    last_model?: string | null;
    archived_at?: number | null;
}

function toRecord(r: SessionRow): SessionRecord {
    return {
        rowId: r.id,
        info: {
            id: r.pub_id,
            createdAt: r.created_at,
            cwd: r.cwd,
            provider: r.provider as ProviderId,
            model: r.model,
            ...(r.parent_pub ? { parentSession: r.parent_pub } : {}),
        },
        name: r.name ?? undefined,
        updatedAt: r.updated_at,
        firstUserPayload: r.first_user_payload ?? undefined,
        lastModel: r.last_model ?? undefined,
        archivedAt: r.archived_at ?? undefined,
    };
}

const FIRST_USER_PAYLOAD = `(
    SELECT e.payload FROM entries e
    WHERE e.session_id = s.id AND e.type = 'message' AND e.role = 'user'
    ORDER BY e.id LIMIT 1
) AS first_user_payload`;

/**
 * The model the session most recently ran on, not the one it was created with.
 *
 * `entries.model` is derived at insert precisely so aggregates never have to
 * parse payload JSON, which is what makes this affordable per row — the
 * alternative, `Session.lastModel()`, would load every entry of every session
 * in the list. It walks all branches rather than the current one; a list row
 * only needs to name the model, and re-reading a session gets the exact answer.
 */
const LAST_MODEL = `(
    SELECT e.model FROM entries e
    WHERE e.session_id = s.id AND e.model IS NOT NULL AND e.model <> ''
    ORDER BY e.id DESC LIMIT 1
) AS last_model`;

export class SessionStore {
    constructor(private db: Database) {}

    /** Insert the session row if it doesn't exist yet; return the internal id. */
    ensureSession(info: SessionInfoData): number {
        this.db
            .query(
                `INSERT OR IGNORE INTO sessions (pub_id, cwd, provider, model, parent_pub, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(info.id, info.cwd, info.provider, info.model, info.parentSession ?? null, info.createdAt, Date.now());
        const row = this.db.query<{ id: number }, [string]>("SELECT id FROM sessions WHERE pub_id = ?").get(info.id);
        if (!row) throw new Error(`session row vanished for ${info.id}`);
        return row.id;
    }

    getSession(pubId: string): SessionRecord | null {
        const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions AS s WHERE pub_id = ?").get(pubId);
        return row ? toRecord(row) : null;
    }

    /**
     * Sessions, newest first.
     *
     * `scope` picks which side of the archive to list. It is a THREE-valued
     * string rather than an optional boolean on purpose: `undefined` had to
     * mean "both", and a defaulted parameter cannot express that — JavaScript
     * applies the default precisely when the argument is `undefined`, so
     * "give me everything" silently became "give me the active ones".
     *
     * `active` is the default because archiving that does not remove the
     * session from the list it was cluttering has achieved nothing.
     */
    listSessions(cwd?: string, scope: SessionScope = "active", page?: SessionPage): SessionRecord[] {
        const where: string[] = [];
        if (cwd !== undefined) where.push("s.cwd = ?");
        // Ids are ULIDs; anything else is dropped rather than interpolated.
        const ids = page?.ids?.filter((id) => /^[0-9A-Za-z_-]{1,64}$/.test(id));
        if (ids) where.push(ids.length ? `s.pub_id IN (${ids.map((id) => `'${id}'`).join(",")})` : "0");
        if (scope === "archived") where.push("s.archived_at IS NOT NULL");
        else if (scope === "active") where.push("s.archived_at IS NULL");
        const sql = `SELECT s.*, ${FIRST_USER_PAYLOAD}, ${LAST_MODEL} FROM sessions s
                     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                     ORDER BY ${scope === "archived" ? "s.archived_at" : "s.updated_at"} DESC, s.id DESC
                     ${pageClause(page)}`;
        const rows =
            cwd !== undefined
                ? this.db.query<SessionRow, [string]>(sql).all(cwd)
                : this.db.query<SessionRow, []>(sql).all();
        return rows.map(toRecord);
    }

    /**
     * Every folder that has a session in `scope`, newest first, with how many
     * and when they span. What a paged list still needs whole: a project with
     * only old sessions must not vanish from the sidebar because none of them
     * made the first page.
     */
    listSessionFolders(scope: SessionScope = "active"): SessionFolder[] {
        const where =
            scope === "archived" ? "WHERE archived_at IS NOT NULL" : scope === "active" ? "WHERE archived_at IS NULL" : "";
        return this.db
            .query<SessionFolder, []>(
                `SELECT cwd, COUNT(*) AS count, MIN(created_at) AS createdAt, MAX(updated_at) AS updatedAt
                 FROM sessions ${where} GROUP BY cwd ORDER BY updatedAt DESC`,
            )
            .all();
    }

    /**
     * Put a session away, or take it back out. Returns false when there was no
     * such session, so a caller can tell "already gone" from "archived it".
     *
     * Nothing is deleted and no entry is written: archiving is a property of
     * the session row, not a turn in the conversation, so it must not appear
     * in the transcript or reach the model.
     */
    setSessionArchived(pubId: string, archived: boolean): boolean {
        const result = this.db
            .query("UPDATE sessions SET archived_at = ? WHERE pub_id = ?")
            .run(archived ? Date.now() : null, pubId);
        return result.changes > 0;
    }

    /**
     * Delete a session and everything under it. Returns false when there was
     * no such session, so a caller can tell "gone" from "never existed".
     *
     * Entries go with it by cascade (`PRAGMA foreign_keys = ON`, db.ts), and
     * the cost ledger deliberately does NOT: its FK is ON DELETE SET NULL and
     * it keeps `session_pub`, so deleting a conversation never rewrites what
     * was actually spent.
     */
    deleteSession(pubId: string): boolean {
        const result = this.db.query("DELETE FROM sessions WHERE pub_id = ?").run(pubId);
        return result.changes > 0;
    }

    /** Re-home a session to a new working directory (/cd). */
    updateSessionCwd(pubId: string, cwd: string): void {
        this.db.query("UPDATE sessions SET cwd = ?, updated_at = ? WHERE pub_id = ?").run(cwd, Date.now(), pubId);
    }

    /** Append one batch of entries in a single transaction (the appendAll contract). */
    appendEntries(sessionRowId: number, entries: Entry[]): void {
        if (entries.length === 0) return;
        const tx = this.db.transaction(() => {
            for (const e of entries) this.insertEntry(sessionRowId, e);
            this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), sessionRowId);
            this.applyNameChanges(sessionRowId, entries);
        });
        tx();
    }

    loadEntries(sessionRowId: number): Entry[] {
        const rows = this.db
            .query<{ payload: string }, [number]>("SELECT payload FROM entries WHERE session_id = ? ORDER BY id")
            .all(sessionRowId);
        return rows.map((r) => JSON.parse(r.payload) as Entry);
    }

    /**
     * Rewrite a session's entries wholesale — the legacy-upgrade path
     * (ensureTreeFields assigned ids on load), replacing the old rewriteFile.
     */
    replaceEntries(sessionRowId: number, entries: Entry[]): void {
        const tx = this.db.transaction(() => {
            this.db.query("DELETE FROM entries WHERE session_id = ?").run(sessionRowId);
            for (const e of entries) this.insertEntry(sessionRowId, e);
        });
        tx();
    }

    /** Create a session and its entries atomically — the fork path. */
    insertSessionWithEntries(info: SessionInfoData, entries: Entry[]): number {
        const tx = this.db.transaction(() => {
            const rowId = this.ensureSession(info);
            for (const e of entries) this.insertEntry(rowId, e);
            this.applyNameChanges(rowId, entries);
            return rowId;
        });
        return tx() as number;
    }

    /**
     * input+output tokens per local calendar day, across all sessions — the
     * /steak heatmap. date(…,'localtime') matches toLocaleDateString("sv").
     */
    dailyTokens(): Map<string, number> {
        const rows = this.db
            .query<{ day: string; toks: number }, []>(
                // usage_estimated=1 rows are interrupted-turn guesses that
                // /cost never bills — counting them in /steak was invariant
                // 5's pre-existing inconsistency (DESIGN.md §1b).
                `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                        SUM(COALESCE(usage_input, 0) + COALESCE(usage_output, 0)) AS toks
                 FROM entries
                 WHERE ((type = 'message' AND role = 'assistant') OR type = 'subagent')
                   AND COALESCE(usage_input, 0) + COALESCE(usage_output, 0) > 0
                   AND COALESCE(usage_estimated, 0) = 0
                 GROUP BY day`,
            )
            .all();
        return new Map(rows.map((r) => [r.day, r.toks]));
    }

    private insertEntry(sessionRowId: number, e: Entry): void {
        const usage = "usage" in e && e.usage ? normalizeUsage(e.usage) : null;
        this.db
            .query(
                `INSERT INTO entries (
                    session_id, pub_id, parent_pub_id, ts, type, role, payload,
                    usage_input, usage_output, usage_total, usage_no_cache,
                    usage_cache_read, usage_cache_write, usage_text,
                    usage_reasoning, usage_estimated, usage_usd, model
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                sessionRowId,
                e.id!,
                e.parentId ?? null,
                e.ts,
                e.type,
                e.type === "message" ? e.role : null,
                JSON.stringify(e),
                usage?.input ?? null,
                usage?.output ?? null,
                usage?.total ?? null,
                usage?.noCache ?? null,
                usage?.cacheRead ?? null,
                usage?.cacheWrite ?? null,
                usage?.text ?? null,
                usage?.reasoning ?? null,
                usage ? (usage.estimated ? 1 : 0) : null,
                usage?.usd ?? null,
                "model" in e ? (e.model ?? null) : null,
            );
    }

    /** Denormalize the latest session-name in a batch onto the session row. */
    private applyNameChanges(sessionRowId: number, entries: Entry[]): void {
        let seen = false;
        let name: string | null = null;
        for (const e of entries) {
            if (e.type !== "session-name") continue;
            seen = true;
            name = e.name?.trim() || null;
        }
        if (seen) this.db.query("UPDATE sessions SET name = ? WHERE id = ?").run(name, sessionRowId);
    }
}

let cached: { db: Database; store: SessionStore } | null = null;

/** The store bound to the current db singleton (re-bound when tests swap the path). */
export function getSessionStore(): SessionStore {
    const db = getDb();
    if (!cached || cached.db !== db) cached = { db, store: new SessionStore(db) };
    return cached.store;
}

/** A slice of a newest-first list. Absent = everything (every older caller). */
export interface SessionPage {
    readonly limit?: number;
    readonly offset?: number;
    /** Only these sessions (by public id) — what a client has open. */
    readonly ids?: readonly string[];
}

export interface SessionFolder {
    readonly cwd: string;
    readonly count: number;
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** LIMIT/OFFSET from validated integers only — they are interpolated, not bound. */
function pageClause(page: SessionPage | undefined): string {
    const limit = page?.limit;
    const offset = page?.offset;
    const ok = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n) && n >= 0;
    if (!ok(limit)) return ok(offset) && offset > 0 ? `LIMIT -1 OFFSET ${offset}` : "";
    return `LIMIT ${limit}${ok(offset) && offset > 0 ? ` OFFSET ${offset}` : ""}`;
}
