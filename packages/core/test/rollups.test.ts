import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CostTracker } from "../src/agent/cost";
import { addLedgerRow, ledgerCwdUsd, ledgerDailyUsd, ledgerLifetime } from "../src/sessions/cost-ledger";
import { closeDb, getDb } from "../src/sessions/db";
import { SessionManager } from "../src/sessions";
import type { UsageBlock } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

const MODEL = "xai/grok-build-0.1";
const DAY_MS = 24 * 60 * 60 * 1000;

const usage = (input: number, output: number): UsageBlock => ({
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
});

/*
 * The oracle: the queries /steak and /cost ran before the totals existed,
 * straight over the raw tables. Every test asserts the totals still agree.
 */
function rawDailyTokens(): Map<string, number> {
    const rows = getDb()
        .query<{ day: string; toks: number }, []>(
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

function rawLedger(): { byProvider: Record<string, number>; daily: Map<string, number>; cwd: number } {
    const db = getDb();
    const billed = "FROM cost_ledger WHERE estimated = 0 AND backfilled = 0";
    const providers = db.query<{ p: string; usd: number }, []>(`SELECT provider AS p, SUM(usd) AS usd ${billed} GROUP BY provider`).all();
    const days = db.query<{ day: string; usd: number }, []>(`SELECT day, SUM(usd) AS usd ${billed} GROUP BY day`).all();
    const cwd = db.query<{ usd: number }, []>(`SELECT COALESCE(SUM(usd), 0) AS usd ${billed} AND cwd = '/proj'`).get();
    return {
        byProvider: Object.fromEntries(providers.map((r) => [r.p, r.usd])),
        daily: new Map(days.map((r) => [r.day, r.usd])),
        cwd: cwd?.usd ?? 0,
    };
}

function expectTotalsMatchRawRows(): void {
    expect(new SessionManager().dailyTokens()).toEqual(rawDailyTokens());
    const raw = rawLedger();
    const life = ledgerLifetime();
    for (const [provider, usd] of Object.entries(raw.byProvider)) expect(life.byProvider[provider]).toBeCloseTo(usd, 9);
    for (const [day, usd] of raw.daily) expect(ledgerDailyUsd().get(day)).toBeCloseTo(usd, 9);
    expect(ledgerCwdUsd("/proj")).toBeCloseTo(raw.cwd, 9);
}

function bill(usd: number, opts: { ts?: number; cwd?: string | null; provider?: string; estimated?: boolean; backfilled?: boolean } = {}) {
    return addLedgerRow({
        provider: opts.provider ?? "xai",
        model: MODEL,
        usage: usage(10, 1),
        usd,
        ts: opts.ts,
        estimated: opts.estimated,
        backfilled: opts.backfilled,
        ctx: { source: "turn", cwd: opts.cwd === null ? undefined : (opts.cwd ?? "/proj") },
    });
}

/** A session with a spread of entries: counted, estimated, user, subagent, and across days. */
async function busySession(manager: SessionManager) {
    const session = await manager.create({ cwd: "/proj", provider: "xai", model: MODEL });
    const now = Date.now();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    await session.append({ type: "message", role: "user", content: "hi", ts: now });
    await session.append({ type: "message", role: "assistant", content: "a", ts: now, usage: usage(100, 10) });
    await session.append({ type: "message", role: "assistant", content: "b", ts: now - 3 * DAY_MS, usage: usage(7, 3) });
    // Either side of a local midnight: the quarter-hour bucket must land in the same day the raw ts does.
    await session.append({ type: "message", role: "assistant", content: "c", ts: midnight.getTime() - 1, usage: usage(5, 0) });
    await session.append({ type: "message", role: "assistant", content: "d", ts: midnight.getTime(), usage: usage(0, 9) });
    await session.append({
        type: "message",
        role: "assistant",
        content: "guess",
        interrupted: true,
        ts: now,
        usage: { ...usage(1_000_000, 0), estimated: true },
    });
    return session;
}

describe("trigger-kept totals for /steak and /cost", () => {
    test("every write path keeps them equal to the raw tables", async () => {
        const manager = new SessionManager();
        const kept = await busySession(manager);
        const dropped = await busySession(manager);
        bill(0.5);
        bill(0.25, { ts: Date.now() - 2 * DAY_MS, provider: "anthropic" });
        bill(9, { estimated: true });
        bill(7, { backfilled: true });
        bill(0.125, { cwd: null });
        const regraded = bill(3, { estimated: true });
        expectTotalsMatchRawRows();

        // A session deleted: its entries go by foreign-key cascade, which fires the triggers too.
        expect(manager.delete(dropped.id)).toBe(true);
        // A row re-graded in place, and one removed.
        getDb().run("UPDATE cost_ledger SET estimated = 0 WHERE id = ?", [regraded]);
        getDb().run("DELETE FROM cost_ledger WHERE usd = 0.5");
        expect(kept.id).toBeTruthy();
        expectTotalsMatchRawRows();
    });

    test("/steak and /cost read the totals, never the raw tables", async () => {
        await busySession(new SessionManager());
        bill(0.5);
        const before = { tokens: new SessionManager().dailyTokens(), cost: new CostTracker().stats("/proj") };
        // Empty the raw tables behind the triggers' back: an answer that still
        // matches came from the totals alone.
        getDb().exec(`
            DROP TRIGGER usage_rollup_delete; DROP TRIGGER ledger_rollup_delete;
            DELETE FROM cost_ledger; DELETE FROM entries;
        `);
        expect(new SessionManager().dailyTokens()).toEqual(before.tokens);
        expect(new CostTracker().stats("/proj")).toEqual(before.cost);
    });

    test("a writer that knows nothing of them (another version, pi) still keeps them", () => {
        const path = getDb().query<{ file: string }, []>("PRAGMA database_list").get()!.file;
        bill(1);
        const foreign = new Database(path);
        foreign.run(
            `INSERT INTO cost_ledger (ts, day, source, cwd, provider, model, usd)
             VALUES (?, ?, 'turn', '/proj', 'openai', 'gpt', 2.5)`,
            [Date.now(), "2026-01-02"],
        );
        foreign.close();
        expect(ledgerLifetime().byProvider.openai).toBeCloseTo(2.5, 9);
        expect(ledgerDailyUsd().get("2026-01-02")).toBeCloseTo(2.5, 9);
        expectTotalsMatchRawRows();
    });

    test("a database from before them is caught up on open", async () => {
        const manager = new SessionManager();
        await busySession(manager);
        bill(0.75);
        // What an older build leaves behind: the raw rows and no totals.
        getDb().exec(`
            DROP TABLE usage_rollup; DROP TABLE ledger_rollup;
            DELETE FROM meta WHERE key = 'rollups_version';
        `);
        closeDb();

        expectTotalsMatchRawRows();
        expect(new CostTracker().stats("/proj").cwdUsd).toBeCloseTo(0.75, 9);
    });

    test("a stale stamp rebuilds them rather than trusting wrong totals", async () => {
        const manager = new SessionManager();
        await busySession(manager);
        bill(0.75);
        getDb().exec(`
            UPDATE usage_rollup SET tokens = tokens * 1000; UPDATE ledger_rollup SET usd = 999;
            UPDATE meta SET value = 'old' WHERE key = 'rollups_version';
        `);
        closeDb();

        expectTotalsMatchRawRows();
    });
});
