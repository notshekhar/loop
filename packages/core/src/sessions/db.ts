import { getConfigDir, PRODUCT_NAME } from "../brand";
import { openSqlite, sleepSyncMs, type SqliteDatabase as Database } from "./sqlite";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "../debug";

/**
 * The one place that opens the session database. Everything session-adjacent
 * (transcripts, cost ledger, per-project trust/model, reminders) lives in this
 * single WAL SQLite file; nothing else in the codebase touches `new Database`.
 *
 * The path must come from getConfigDir(): inside a compiled binary
 * `import.meta.dir` is the read-only /$bunfs bundle and opening a DB there
 * fails with SQLITE_CANTOPEN.
 *
 * The handle itself comes from ./sqlite, which hands back the real
 * `bun:sqlite` Database under Bun and a thin `node:sqlite` adapter under Node
 * — so core works as a library inside Electron's main process without the CLI
 * changing behaviour at all.
 */

const SCHEMA_VERSION = 7;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pub_id     TEXT NOT NULL UNIQUE,
    cwd        TEXT NOT NULL,
    provider   TEXT NOT NULL,
    model      TEXT NOT NULL,
    name       TEXT,
    parent_pub TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd, updated_at DESC);

CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pub_id        TEXT NOT NULL,
    parent_pub_id TEXT,
    ts            INTEGER NOT NULL,
    type          TEXT NOT NULL,
    role          TEXT,
    payload       TEXT NOT NULL,
    usage_input       INTEGER,
    usage_output      INTEGER,
    usage_total       INTEGER,
    usage_no_cache    INTEGER,
    usage_cache_read  INTEGER,
    usage_cache_write INTEGER,
    usage_text        INTEGER,
    usage_reasoning   INTEGER,
    usage_estimated   INTEGER,
    usage_usd         REAL,
    model             TEXT,
    UNIQUE (session_id, pub_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, id);
CREATE INDEX IF NOT EXISTS idx_entries_usage ON entries(ts) WHERE usage_input IS NOT NULL;

CREATE TABLE IF NOT EXISTS cost_ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    day          TEXT NOT NULL,
    session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    session_pub  TEXT,
    entry_id     INTEGER REFERENCES entries(id) ON DELETE SET NULL,
    entry_pub    TEXT,
    source       TEXT NOT NULL,
    cwd          TEXT,
    provider     TEXT NOT NULL,
    model        TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    no_cache_tokens    INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens   INTEGER,
    price_input       REAL,
    price_output      REAL,
    price_cache_read  REAL,
    price_cache_write REAL,
    usd           REAL NOT NULL,
    provider_cost REAL,
    estimated     INTEGER NOT NULL DEFAULT 0,
    backfilled    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ledger_day ON cost_ledger(day) WHERE estimated = 0 AND backfilled = 0;
CREATE INDEX IF NOT EXISTS idx_ledger_cwd ON cost_ledger(cwd) WHERE estimated = 0 AND backfilled = 0;
CREATE INDEX IF NOT EXISTS idx_ledger_session ON cost_ledger(session_pub);

CREATE TABLE IF NOT EXISTS projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    dir             TEXT NOT NULL UNIQUE,
    trust           INTEGER,
    model           TEXT,
    provider_models TEXT,
    bash_allow      TEXT,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pub_id     TEXT NOT NULL UNIQUE,
    text       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    kind       TEXT NOT NULL,
    at         INTEGER,
    expr       TEXT,
    created_at INTEGER NOT NULL
);

-- Thread teams (teams/store.ts). New tables only, never a column on an
-- existing one, and no schema_version bump: the desktop and the CLI share
-- this file and update apart, and a build that finds a newer version refuses
-- the whole database. An older build simply never looks at these.
CREATE TABLE IF NOT EXISTS teams (
    id         TEXT PRIMARY KEY,
    lead_pub   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    stopped_at INTEGER
);
CREATE TABLE IF NOT EXISTS team_members (
    session_pub TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL,
    role        TEXT NOT NULL,
    state       TEXT NOT NULL,
    activity    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE TABLE IF NOT EXISTS team_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id      TEXT NOT NULL,
    from_pub     TEXT NOT NULL,
    to_pub       TEXT,
    kind         TEXT NOT NULL,
    board_key    TEXT,
    body         TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_team_messages_inbox ON team_messages(to_pub, delivered_at);
CREATE INDEX IF NOT EXISTS idx_team_messages_team ON team_messages(team_id, kind);

CREATE TABLE IF NOT EXISTS goals (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    pub_id              TEXT NOT NULL UNIQUE,
    text                TEXT NOT NULL,
    cwd                 TEXT NOT NULL,
    model               TEXT,
    agent               TEXT,
    kind                TEXT NOT NULL,
    at                  INTEGER,
    expr                TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    created_at          INTEGER NOT NULL,
    last_run_at         INTEGER,
    last_run_session_id TEXT,
    last_run_status     TEXT,
    last_run_summary    TEXT
);
`;

let db: Database | null = null;
let overridePath: string | null = null;

/** Brand-free db filename, so a product rename only has to move the config dir. */
export const DB_FILE_NAME = "agent.db";

function defaultDbPath(): string {
    return join(getConfigDir(), DB_FILE_NAME);
}

/**
 * Open → pragmas → schema, as one retried unit. busy_timeout must be set
 * before the WAL switch (the switch itself takes a lock), and the first-ever
 * WAL switch on a fresh file can still return SQLITE_BUSY when two processes
 * create it simultaneously — busy_timeout does not reliably cover that, so
 * the whole init retries with backoff. On an existing WAL file no retry is
 * ever needed.
 */
function openDb(path: string, recovered = false): Database {
    // SQLite can create the file but not its parent (fresh install / temp HOME).
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
        let candidate: Database | null = null;
        try {
            candidate = openSqlite(path, { create: true });
            candidate.exec("PRAGMA busy_timeout = 5000");
            candidate.exec("PRAGMA journal_mode = WAL");
            candidate.exec("PRAGMA synchronous = NORMAL");
            candidate.exec("PRAGMA foreign_keys = ON");
            candidate.exec(SCHEMA);
            candidate.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [
                String(SCHEMA_VERSION),
            ]);
            const row = candidate
                .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
                .get();
            const version = Number(row?.value ?? SCHEMA_VERSION);
            if (version > SCHEMA_VERSION) {
                throw new Error(
                    `session db ${path} is schema v${version}, newer than this build (v${SCHEMA_VERSION}) — upgrade ${PRODUCT_NAME}`,
                );
            }
            if (version < SCHEMA_VERSION) {
                // v1 → v2: usage_usd (the billed-USD stamp denormalized for
                // aggregate queries; payload stays the source of truth) and
                // cost_ledger.entry_id/entry_pub (link a ledger row to the
                // entry it billed, for cost-split analysis — NULL on rows with
                // no attributable entry, e.g. pre-migration spend).
                // v2 → v3: projects.provider_models (JSON provider→model map,
                // was settings.projectProviderModels).
                // v3 → v4: goals table — new table only, created by the
                // SCHEMA exec above, so no ALTERs; the version stamp is the
                // whole migration.
                // v4 → v5: goals.agent (which agent runs the goal; NULL =
                // the global agent setting at run time).
                // v5 → v6: projects.bash_allow (JSON string array — the
                // per-project "always allow" grants the bash approval prompt
                // persists; was the global settings.bashAllow key).
                // v6 → v7: sessions.archived_at (epoch ms; NULL = active).
                // Archiving is deliberately a timestamp rather than a flag —
                // "when did I put this away" is the question an archive list
                // sorts by, and a boolean cannot answer it.
                // Two processes can race an ALTER — the loser's
                // duplicate-column error is the success case, everything else
                // still throws.
                const alters = [
                    ...(version < 2
                        ? [
                              "ALTER TABLE entries ADD COLUMN usage_usd REAL",
                              "ALTER TABLE cost_ledger ADD COLUMN entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL",
                              "ALTER TABLE cost_ledger ADD COLUMN entry_pub TEXT",
                          ]
                        : []),
                    ...(version < 3 ? ["ALTER TABLE projects ADD COLUMN provider_models TEXT"] : []),
                    ...(version < 5 ? ["ALTER TABLE goals ADD COLUMN agent TEXT"] : []),
                    ...(version < 6 ? ["ALTER TABLE projects ADD COLUMN bash_allow TEXT"] : []),
                    ...(version < 7 ? ["ALTER TABLE sessions ADD COLUMN archived_at INTEGER"] : []),
                ];
                for (const alter of alters) {
                    try {
                        candidate.exec(alter);
                    } catch (err) {
                        if (!/duplicate column/i.test(String((err as Error)?.message ?? err))) throw err;
                    }
                }
                candidate.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
            }
            // quick_check scans the whole DB — worth it only after an unclean
            // exit. closeDb() stamps the marker '1'; here it flips to '0' for
            // the duration of the run, so a crash leaves '0' behind and the
            // next open verifies. A missing marker (pre-marker DB) also
            // verifies once, then joins the scheme.
            const clean = candidate
                .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'clean_shutdown'")
                .get();
            if (clean?.value !== "1") {
                const check = candidate.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
                if (check && check.quick_check !== "ok") {
                    debugLog("session-db", `quick_check failed for ${path}: ${check.quick_check}`);
                    // Recover once per open: set the corrupt file aside, start
                    // fresh, and salvage what's readable.
                    // A corrupt :memory: db or a second corruption falls
                    // through and continues on the damaged handle.
                    if (!recovered && path !== ":memory:") {
                        candidate.close();
                        return recoverCorruptDb(path);
                    }
                }
            }
            candidate.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('clean_shutdown', '0')");
            return candidate;
        } catch (err) {
            candidate?.close();
            lastErr = err;
            const msg = String((err as Error)?.message ?? err);
            // Heavier damage surfaces before quick_check ever runs — the very
            // reads/writes of the open sequence throw. Same recovery path.
            if (!recovered && path !== ":memory:" && /malformed|not a database|corrupt/i.test(msg)) {
                debugLog("session-db", `open failed on damaged db ${path}: ${msg}`);
                return recoverCorruptDb(path);
            }
            if (!/SQLITE_BUSY|database is locked/i.test(msg)) throw err;
            sleepSyncMs(25);
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`could not open session db at ${path}: ${lastErr}`);
}

/**
 * Corruption recovery: move the damaged file (and its WAL sidecars — they must
 * never attach to the replacement) aside, open a fresh db, then copy every
 * readable row over.
 *
 * Best-effort by design: a row that can't be read or re-inserted is skipped,
 * never fatal. The damaged file is kept beside the fresh one for forensics.
 * Note: another live process still holding the damaged file keeps writing to
 * the renamed path — acceptable for an already-corrupt store.
 *
 * The caller has already closed its handle to the damaged file.
 */
function recoverCorruptDb(path: string): Database {
    const corruptPath = `${path}.corrupt-${Date.now()}`;
    try {
        renameSync(path, corruptPath);
    } catch (err) {
        // Can't set it aside (permissions?) — reopen and continue on the
        // damaged file rather than losing the app.
        debugLog("session-db", `could not set corrupt db aside, continuing damaged:`, err as Error);
        return openDb(path, true);
    }
    for (const suffix of ["-wal", "-shm"]) {
        try {
            renameSync(path + suffix, corruptPath + suffix);
        } catch {
            // sidecar absent — fine
        }
    }
    const fresh = openDb(path, true);
    salvageCorruptDb(corruptPath, fresh);
    fresh.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('recovered_at', ?)", [String(Date.now())]);
    debugLog("session-db", `recovered ${path}; damaged file kept at ${corruptPath}`);
    return fresh;
}

/** Copy every readable row from the damaged db into the fresh one. Parent
 * tables first so FK checks pass; a child whose parent was lost is skipped. */
function salvageCorruptDb(corruptPath: string, fresh: Database): void {
    let damaged: Database | null = null;
    try {
        damaged = openSqlite(corruptPath);
        for (const table of ["sessions", "entries", "cost_ledger", "projects", "reminders", "goals"]) {
            try {
                const select = damaged.query(`SELECT * FROM ${table}`);
                const cols = select.columnNames;
                if (cols.length === 0) continue;
                const insert = fresh.query(
                    `INSERT OR IGNORE INTO ${table} (${cols.join(", ")})
                     VALUES (${cols.map(() => "?").join(", ")})`,
                );
                let copied = 0;
                fresh.transaction(() => {
                    // iterate() (not all()) so rows before a torn page still
                    // land — and the read-error catch sits INSIDE the
                    // transaction, so a tear mid-table commits the prefix
                    // instead of rolling it back.
                    try {
                        for (const row of select.iterate() as IterableIterator<Record<string, unknown>>) {
                            try {
                                insert.run(...(cols.map((c: string) => row[c]) as never[]));
                                copied++;
                            } catch {
                                // FK parent lost to the corruption — skip the child.
                            }
                        }
                    } catch (err) {
                        debugLog("session-db", `salvage: ${table} tore after ${copied} rows:`, err as Error);
                    }
                })();
                debugLog("session-db", `salvaged ${copied} rows from ${table}`);
            } catch (err) {
                debugLog("session-db", `salvage: ${table} unreadable, its rows are lost:`, err as Error);
            }
        }
        // cost_baseline is the frozen pre-ledger spend — unrecoverable from
        // anywhere else.
        try {
            const baseline = damaged
                .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'cost_baseline'")
                .get();
            if (baseline) {
                fresh.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('cost_baseline', ?)", [baseline.value]);
            }
        } catch (err) {
            debugLog("session-db", "salvage: cost_baseline unreadable:", err as Error);
        }
    } catch (err) {
        debugLog("session-db", `salvage: could not open ${corruptPath}:`, err as Error);
    } finally {
        damaged?.close();
    }
}

export function getDb(): Database {
    if (!db) {
        db = openDb(overridePath ?? defaultDbPath());
    }
    return db;
}

/** Checkpoint and close — call on clean exit so the -wal file doesn't grow unbounded. */
export function closeDb(): void {
    if (!db) return;
    try {
        // Marks this run as cleanly shut down so the next open can skip the
        // full quick_check scan. Best-effort: a failure here just means one
        // extra verification pass next launch.
        db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('clean_shutdown', '1')");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
        debugLog("session-db", "wal_checkpoint on close failed:", err as Error);
    }
    db.close();
    db = null;
}

/** Point the singleton at a temp file or ":memory:" — tests only. */
export function setDbPathForTests(path: string | null): void {
    closeDb();
    overridePath = path;
}
