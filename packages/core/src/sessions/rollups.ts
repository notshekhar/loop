/**
 * Running totals for `/steak` and `/cost`, kept by SQLite triggers.
 *
 * Both commands used to aggregate the raw tables on every call: `/steak`
 * scanned every entry (payload-heavy rows) and `/cost` grouped the whole cost
 * ledger three ways. Those tables only grow, so the commands slowed down with
 * every turn ever billed. The triggers here fold each row into a small total
 * table as it is written, and the commands read the totals instead.
 *
 * The triggers live in the database, not in this code, so every writer keeps
 * the totals right — another loop version, pi (which shares `agent.db`), a
 * foreign-key cascade when a session is deleted. They are new tables and
 * triggers only, so no `schema_version` bump: a build that knows nothing of
 * them still opens the file, and its writes still fire them.
 *
 * Ledger tokens ride along with the dollars so pi's `/cost all` reads them too.
 *
 * Each total mirrors one query exactly, filter for filter, so swapping the
 * query for the total changes no number.
 */
import type { SqliteDatabase as Database } from "./sqlite";

/**
 * Bump when a table, trigger or filter below changes. A database stamped with
 * any other value drops its totals and rebuilds them from the raw rows.
 */
const ROLLUPS_VERSION = "1";

/**
 * `/steak` buckets tokens by local day, and the local day is a read-time
 * question (the machine may change time zone). Quarter hours are the smallest
 * slice every real UTC offset is a multiple of (+5:30, +5:45, −3:30 …), so a
 * quarter-hour total lands in the same local day the raw `ts` would.
 */
export const USAGE_BUCKET_MS = 15 * 60 * 1000;

/** The entries `/steak` counts: billed, non-estimated assistant and subagent usage. */
const COUNTED_ENTRY = (row: "NEW" | "OLD") => `
    ((${row}.type = 'message' AND ${row}.role = 'assistant') OR ${row}.type = 'subagent')
    AND COALESCE(${row}.usage_input, 0) + COALESCE(${row}.usage_output, 0) > 0
    AND COALESCE(${row}.usage_estimated, 0) = 0`;

/** The ledger rows `/cost` bills: real spend, not estimates or backfills. */
const BILLED_ROW = (row: "NEW" | "OLD") => `${row}.estimated = 0 AND ${row}.backfilled = 0`;

/** Fold one row into (sign +1) or out of (sign −1) the usage totals. */
const foldUsage = (row: "NEW" | "OLD", sign: 1 | -1) => `
    INSERT INTO usage_rollup (bucket, tokens)
    SELECT ${row}.ts / ${USAGE_BUCKET_MS},
           ${sign} * (COALESCE(${row}.usage_input, 0) + COALESCE(${row}.usage_output, 0))
    WHERE ${COUNTED_ENTRY(row)}
    ON CONFLICT (bucket) DO UPDATE SET tokens = tokens + excluded.tokens;`;

/** Fold one row into or out of the ledger totals. `cwd` is NOT NULL so it can key. */
const foldLedger = (row: "NEW" | "OLD", sign: 1 | -1) => `
    INSERT INTO ledger_rollup (day, provider, cwd, usd, input_tokens, output_tokens)
    SELECT ${row}.day, ${row}.provider, COALESCE(${row}.cwd, ''),
           ${sign} * ${row}.usd, ${sign} * ${row}.input_tokens, ${sign} * ${row}.output_tokens
    WHERE ${BILLED_ROW(row)}
    ON CONFLICT (day, provider, cwd) DO UPDATE SET
        usd = usd + excluded.usd,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens;`;

/** Columns a total depends on — an UPDATE of anything else (e.g. the ledger's entry link) skips the trigger. */
const USAGE_COLUMNS = "ts, type, role, usage_input, usage_output, usage_estimated";
const LEDGER_COLUMNS = "day, provider, cwd, usd, input_tokens, output_tokens, estimated, backfilled";

const DROP = `
DROP TRIGGER IF EXISTS usage_rollup_insert;
DROP TRIGGER IF EXISTS usage_rollup_delete;
DROP TRIGGER IF EXISTS usage_rollup_update;
DROP TRIGGER IF EXISTS ledger_rollup_insert;
DROP TRIGGER IF EXISTS ledger_rollup_delete;
DROP TRIGGER IF EXISTS ledger_rollup_update;
DROP TABLE IF EXISTS usage_rollup;
DROP TABLE IF EXISTS ledger_rollup;
`;

const CREATE = `
CREATE TABLE usage_rollup (
    bucket INTEGER PRIMARY KEY,
    tokens INTEGER NOT NULL
);
CREATE TABLE ledger_rollup (
    day      TEXT NOT NULL,
    provider TEXT NOT NULL,
    cwd      TEXT NOT NULL,
    usd      REAL NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    PRIMARY KEY (day, provider, cwd)
) WITHOUT ROWID;
CREATE INDEX idx_ledger_rollup_cwd ON ledger_rollup(cwd);

CREATE TRIGGER usage_rollup_insert AFTER INSERT ON entries BEGIN ${foldUsage("NEW", 1)} END;
CREATE TRIGGER usage_rollup_delete AFTER DELETE ON entries BEGIN ${foldUsage("OLD", -1)} END;
CREATE TRIGGER usage_rollup_update AFTER UPDATE OF ${USAGE_COLUMNS} ON entries BEGIN
    ${foldUsage("OLD", -1)} ${foldUsage("NEW", 1)}
END;
CREATE TRIGGER ledger_rollup_insert AFTER INSERT ON cost_ledger BEGIN ${foldLedger("NEW", 1)} END;
CREATE TRIGGER ledger_rollup_delete AFTER DELETE ON cost_ledger BEGIN ${foldLedger("OLD", -1)} END;
CREATE TRIGGER ledger_rollup_update AFTER UPDATE OF ${LEDGER_COLUMNS} ON cost_ledger BEGIN
    ${foldLedger("OLD", -1)} ${foldLedger("NEW", 1)}
END;
`;

/** The one-time catch-up: every row written before the triggers existed. */
const BACKFILL = `
INSERT INTO usage_rollup (bucket, tokens)
SELECT ts / ${USAGE_BUCKET_MS}, SUM(COALESCE(usage_input, 0) + COALESCE(usage_output, 0))
FROM entries AS NEW WHERE ${COUNTED_ENTRY("NEW")}
GROUP BY 1;
INSERT INTO ledger_rollup (day, provider, cwd, usd, input_tokens, output_tokens)
SELECT day, provider, COALESCE(cwd, ''), SUM(usd), SUM(input_tokens), SUM(output_tokens)
FROM cost_ledger AS NEW WHERE ${BILLED_ROW("NEW")}
GROUP BY 1, 2, 3;
`;

function stampedVersion(db: Database): string | undefined {
    return db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'rollups_version'").get()?.value;
}

/**
 * Make sure the totals and their triggers exist and match this build, building
 * them from the raw rows when they don't. Cheap on every open after the first:
 * one meta read.
 *
 * The build runs under a write lock (BEGIN IMMEDIATE) and re-checks the stamp
 * inside it, so two processes opening at once build it once, and no row can
 * be written between the catch-up and the triggers going live.
 */
export function ensureRollups(db: Database): void {
    if (stampedVersion(db) === ROLLUPS_VERSION) return;
    db.exec("BEGIN IMMEDIATE");
    try {
        if (stampedVersion(db) !== ROLLUPS_VERSION) {
            db.exec(DROP);
            db.exec(CREATE);
            db.exec(BACKFILL);
            db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('rollups_version', ?)", [ROLLUPS_VERSION]);
        }
        db.exec("COMMIT");
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
}
