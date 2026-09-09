import { getModelSync } from "../catalog";
import type { UsageBlock } from "../types";
import { getDb } from "./db";
import { normalizeUsage } from "./usage";

/**
 * The cost LEDGER (DESIGN.md §1b): one append-only row per billed API
 * round-trip, carrying the token quantities AND the $/MTok unit prices the
 * dollars were computed from, so every displayed total is a SUM over
 * auditable rows. This module is pure persistence — the billing math
 * (stamp > provider cost > catalog precedence) stays in agent/cost.ts and
 * hands the results in.
 *
 * Money first, attribution second: rows are inserted the moment a step
 * finishes (never lost to a failed persist), and the entry that carried the
 * same usage is attached afterwards via attachLedgerEntry — the one UPDATE
 * this otherwise append-only table sees.
 */

export type LedgerSource =
    | "turn"
    | "subagent"
    | "recap"
    | "compact"
    | "branch-summary"
    | "goal-parse"
    | "goal-planner"
    | "goal-verifier"
    // One short call per session, naming what it is about.
    | "session-title"
    // Auto-generated commit messages. Sessionless — the desktop app's commit
    // dialog asks for one directly, so these rows carry a cwd but no
    // sessionPub, unlike every source above.
    | "commit-message"
    | "recipe"
    | "handoff";

export interface LedgerContext {
    source: LedgerSource;
    cwd?: string;
    sessionPub?: string;
}

/** Local-timezone YYYY-MM-DD — cost buckets roll over at the user's midnight. */
export function dayKey(d = new Date()): string {
    return d.toLocaleDateString("sv");
}

export interface PriceSnapshot {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/** The catalog's current $/MTok rates for a model — NULLs when unknown. */
export function priceSnapshot(modelId: string): PriceSnapshot {
    const m = getModelSync(modelId);
    if (!m) return {};
    return {
        input: m.cost.input,
        output: m.cost.output,
        cacheRead: m.cost.cacheRead,
        cacheWrite: m.cost.cacheWrite,
    };
}

export function addLedgerRow(opts: {
    provider: string;
    model: string;
    usage: UsageBlock;
    usd: number;
    /** Provider-reported dollars (openrouter). When set, usd equals it. */
    providerCost?: number;
    prices?: PriceSnapshot;
    estimated?: boolean;
    backfilled?: boolean;
    ts?: number;
    ctx: LedgerContext;
}): number {
    const db = getDb();
    const n = normalizeUsage(opts.usage);
    const ts = opts.ts ?? Date.now();
    const sessionRow = opts.ctx.sessionPub
        ? db.query<{ id: number }, [string]>("SELECT id FROM sessions WHERE pub_id = ?").get(opts.ctx.sessionPub)
        : null;
    const res = db
        .query(
            `INSERT INTO cost_ledger (
                ts, day, session_id, session_pub, source, cwd, provider, model,
                input_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens,
                output_tokens, reasoning_tokens,
                price_input, price_output, price_cache_read, price_cache_write,
                usd, provider_cost, estimated, backfilled
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            ts,
            dayKey(new Date(ts)),
            sessionRow?.id ?? null,
            opts.ctx.sessionPub ?? null,
            opts.ctx.source,
            opts.ctx.cwd ?? null,
            opts.provider,
            opts.model,
            n.input ?? 0,
            n.noCache ?? null,
            n.cacheRead ?? null,
            n.cacheWrite ?? null,
            n.output ?? 0,
            n.reasoning ?? null,
            opts.prices?.input ?? null,
            opts.prices?.output ?? null,
            opts.prices?.cacheRead ?? null,
            opts.prices?.cacheWrite ?? null,
            opts.usd,
            opts.providerCost ?? null,
            opts.estimated ? 1 : 0,
            opts.backfilled ? 1 : 0,
        );
    return Number(res.lastInsertRowid);
}

/** Attribution back-fill: link a billed row to the entry that carried its usage. */
export function attachLedgerEntry(rowId: number, entryPub: string): void {
    const db = getDb();
    db.run(
        `UPDATE cost_ledger SET entry_pub = ?,
            entry_id = (SELECT e.id FROM entries e
                        WHERE e.pub_id = ? AND e.session_id = cost_ledger.session_id)
         WHERE id = ?`,
        [entryPub, entryPub, rowId],
    );
}

export interface LedgerSessionSums {
    rows: number;
    usd: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    /** Any estimated (interrupted-turn) row in the session — drives the `~`. */
    estimated: boolean;
}

/**
 * The recorded spend of one session — ALL rows, including estimated and
 * backfilled: a session's displayed total is whatever was recorded for it
 * (invariant 1), while billing views separately exclude those flags.
 */
export function sumLedgerForSession(sessionPub: string): LedgerSessionSums {
    const db = getDb();
    const row = db
        .query<{ rows: number; usd: number; inp: number; out: number; cached: number; est: number }, [string]>(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(usd), 0) AS usd,
                    COALESCE(SUM(input_tokens), 0) AS inp,
                    COALESCE(SUM(output_tokens), 0) AS out,
                    COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cached,
                    MAX(estimated) AS est
             FROM cost_ledger WHERE session_pub = ?`,
        )
        .get(sessionPub);
    return {
        rows: row?.rows ?? 0,
        usd: row?.usd ?? 0,
        inputTokens: row?.inp ?? 0,
        outputTokens: row?.out ?? 0,
        cachedInputTokens: row?.cached ?? 0,
        estimated: (row?.est ?? 0) === 1,
    };
}

/** Real billed spend (estimated and backfilled excluded) since the ledger cutover. */
export function ledgerLifetime(): { usd: number; byProvider: Record<string, number> } {
    const db = getDb();
    const rows = db
        .query<{ provider: string; usd: number }, []>(
            "SELECT provider, SUM(usd) AS usd FROM cost_ledger WHERE estimated = 0 AND backfilled = 0 GROUP BY provider",
        )
        .all();
    const byProvider: Record<string, number> = {};
    let usd = 0;
    for (const r of rows) {
        byProvider[r.provider] = r.usd;
        usd += r.usd;
    }
    return { usd, byProvider };
}

/** day → usd for real billed spend (powers today/7d/month). */
export function ledgerDailyUsd(): Map<string, number> {
    const db = getDb();
    const rows = db
        .query<{ day: string; usd: number }, []>(
            "SELECT day, SUM(usd) AS usd FROM cost_ledger WHERE estimated = 0 AND backfilled = 0 GROUP BY day",
        )
        .all();
    return new Map(rows.map((r) => [r.day, r.usd]));
}

export function ledgerCwdUsd(cwd: string): number {
    const db = getDb();
    const row = db
        .query<{ usd: number }, [string]>(
            "SELECT COALESCE(SUM(usd), 0) AS usd FROM cost_ledger WHERE cwd = ? AND estimated = 0 AND backfilled = 0",
        )
        .get(cwd);
    return row?.usd ?? 0;
}

// ---------------------------------------------------------------------------
// Baseline (pre-ledger spend, frozen into meta.cost_baseline at the v0.9.0
// cutover — read-only ever since)
// ---------------------------------------------------------------------------

export interface CostBaseline {
    lifetime: { usd: number; byProvider: Record<string, number> };
    daily: Record<string, number>;
    byCwd: Record<string, number>;
}

const EMPTY_BASELINE: CostBaseline = { lifetime: { usd: 0, byProvider: {} }, daily: {}, byCwd: {} };

/** A stored number, defended against a corrupt snapshot. */
function num(x: unknown): number {
    return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

export function getCostBaseline(): CostBaseline {
    const db = getDb();
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'cost_baseline'").get();
    if (!row) return EMPTY_BASELINE;
    try {
        const raw = JSON.parse(row.value) as Partial<CostBaseline>;
        const byProvider: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw.lifetime?.byProvider ?? {})) byProvider[k] = num(v);
        const daily: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw.daily ?? {})) daily[k] = num(v);
        const byCwd: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw.byCwd ?? {})) byCwd[k] = num(v);
        return { lifetime: { usd: num(raw.lifetime?.usd), byProvider }, daily, byCwd };
    } catch {
        return EMPTY_BASELINE;
    }
}

// ---------------------------------------------------------------------------
// Audit (invariant 3 + 4 — `loop cost audit`)
// ---------------------------------------------------------------------------

export interface LedgerAudit {
    rows: number;
    /** Rows whose qty × snapshot-price disagrees with their usd (invariant 3). */
    priceViolations: Array<{ id: number; model: string; usd: number; computed: number }>;
    /** Sessions whose ledger token sums disagree with their entries (invariant 4). */
    sessionMismatches: Array<{
        sessionPub: string;
        ledgerInput: number;
        entriesInput: number;
        ledgerOutput: number;
        entriesOutput: number;
    }>;
}

export function auditLedger(): LedgerAudit {
    const db = getDb();
    const rows = db
        .query<
            {
                id: number;
                model: string;
                usd: number;
                no_cache_tokens: number | null;
                input_tokens: number;
                cache_read_tokens: number | null;
                cache_write_tokens: number | null;
                output_tokens: number;
                price_input: number | null;
                price_output: number | null;
                price_cache_read: number | null;
                price_cache_write: number | null;
            },
            []
        >(
            // provider_cost rows bill at the provider's reported figure and
            // stamp-priced backfill rows have no snapshot — neither is
            // recomputable from prices, so the formula check skips them.
            `SELECT id, model, usd, no_cache_tokens, input_tokens, cache_read_tokens,
                    cache_write_tokens, output_tokens,
                    price_input, price_output, price_cache_read, price_cache_write
             FROM cost_ledger WHERE provider_cost IS NULL AND price_input IS NOT NULL`,
        )
        .all();
    const priceViolations: LedgerAudit["priceViolations"] = [];
    for (const r of rows) {
        const noCache =
            r.no_cache_tokens ?? Math.max(0, r.input_tokens - (r.cache_read_tokens ?? 0) - (r.cache_write_tokens ?? 0));
        const computed =
            (noCache / 1e6) * (r.price_input ?? 0) +
            (r.output_tokens / 1e6) * (r.price_output ?? 0) +
            ((r.cache_read_tokens ?? 0) / 1e6) * (r.price_cache_read ?? 0) +
            ((r.cache_write_tokens ?? 0) / 1e6) * (r.price_cache_write ?? 0);
        // Absolute epsilon for float accumulation; 0.1% relative for rounding.
        if (Math.abs(computed - r.usd) > Math.max(1e-6, r.usd * 0.001)) {
            priceViolations.push({ id: r.id, model: r.model, usd: r.usd, computed });
        }
    }

    const totalRows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cost_ledger").get()?.n ?? 0;

    // Invariant 4: per session, turn+subagent ledger token sums == the token
    // sums of that session's usage-bearing entries.
    const mismatches = db
        .query<{ session_pub: string; l_in: number; e_in: number; l_out: number; e_out: number }, []>(
            // Entry side counts only message/subagent usage — compact,
            // branch-summary, and recap entries carry usage too, but their
            // ledger rows have their own sources and are excluded here.
            `SELECT l.session_pub,
                    SUM(l.input_tokens) AS l_in,
                    (SELECT COALESCE(SUM(e.usage_input), 0) FROM entries e
                     WHERE e.session_id = l.session_id AND e.usage_input IS NOT NULL
                       AND e.type IN ('message', 'subagent')) AS e_in,
                    SUM(l.output_tokens) AS l_out,
                    (SELECT COALESCE(SUM(e.usage_output), 0) FROM entries e
                     WHERE e.session_id = l.session_id AND e.usage_input IS NOT NULL
                       AND e.type IN ('message', 'subagent')) AS e_out
             FROM cost_ledger l
             WHERE l.source IN ('turn', 'subagent') AND l.session_id IS NOT NULL
             GROUP BY l.session_pub, l.session_id
             HAVING l_in != e_in OR l_out != e_out`,
        )
        .all();

    return {
        rows: totalRows,
        priceViolations,
        sessionMismatches: mismatches.map((m) => ({
            sessionPub: m.session_pub,
            ledgerInput: m.l_in,
            entriesInput: m.e_in,
            ledgerOutput: m.l_out,
            entriesOutput: m.e_out,
        })),
    };
}
