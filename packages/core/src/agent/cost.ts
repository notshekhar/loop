import { getModelSync } from "../catalog";
import { debugLog } from "../debug";
import type { CostBreakdown, ProviderId, UsageBlock } from "../types";
import type { Session } from "../sessions";
import {
    addLedgerRow,
    dayKey,
    getCostBaseline,
    ledgerCwdUsd,
    ledgerDailyUsd,
    ledgerLifetime,
    priceSnapshot,
    sumLedgerForSession,
    type LedgerSource,
} from "../sessions/cost-ledger";
import { parseModelId } from "../providers";

export interface CostStats {
    lifetimeUsd: number;
    byProvider: Record<string, number>;
    todayUsd: number;
    last7Usd: number;
    monthUsd: number;
    cwdUsd: number;
}

/** Where a billed round-trip came from — rides the ledger row. */
export interface AddContext {
    cwd?: string;
    sessionPub?: string;
    source?: LedgerSource;
}

/** Sum two usage blocks field-wise — used to keep a running per-step total so
 * aborted runs can still persist the usage of the steps that completed. */
export function sumUsage(a: UsageBlock | undefined, b: UsageBlock): UsageBlock {
    if (!a) return { ...b, inputTokenDetails: b.inputTokenDetails ? { ...b.inputTokenDetails } : undefined };
    const n = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
    const details =
        a.inputTokenDetails || b.inputTokenDetails
            ? {
                  noCacheTokens: n(a.inputTokenDetails?.noCacheTokens, b.inputTokenDetails?.noCacheTokens),
                  cacheReadTokens: n(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens),
                  cacheWriteTokens: n(a.inputTokenDetails?.cacheWriteTokens, b.inputTokenDetails?.cacheWriteTokens),
              }
            : undefined;
    const outDetails =
        a.outputTokenDetails || b.outputTokenDetails
            ? {
                  textTokens: n(a.outputTokenDetails?.textTokens, b.outputTokenDetails?.textTokens),
                  reasoningTokens: n(a.outputTokenDetails?.reasoningTokens, b.outputTokenDetails?.reasoningTokens),
              }
            : undefined;
    const usdDetails =
        a.usdDetails || b.usdDetails
            ? {
                  input: n(a.usdDetails?.input, b.usdDetails?.input),
                  output: n(a.usdDetails?.output, b.usdDetails?.output),
                  cacheRead: n(a.usdDetails?.cacheRead, b.usdDetails?.cacheRead),
                  cacheWrite: n(a.usdDetails?.cacheWrite, b.usdDetails?.cacheWrite),
              }
            : undefined;
    // v7 reports reasoning tokens nested under outputTokenDetails; old (v6)
    // sessions used the flat field. Keep the flat field in sync off either.
    const reasoning = n(
        a.outputTokenDetails?.reasoningTokens ?? a.reasoningTokens,
        b.outputTokenDetails?.reasoningTokens ?? b.reasoningTokens,
    );
    return {
        inputTokens: n(a.inputTokens, b.inputTokens),
        outputTokens: n(a.outputTokens, b.outputTokens),
        totalTokens: n(a.totalTokens, b.totalTokens),
        cachedInputTokens: n(
            a.inputTokenDetails?.cacheReadTokens ?? a.cachedInputTokens,
            b.inputTokenDetails?.cacheReadTokens ?? b.cachedInputTokens,
        ),
        reasoningTokens: reasoning,
        cost: n(a.cost, b.cost),
        inputTokenDetails: details,
        outputTokenDetails: outDetails,
        usd: n(a.usd, b.usd),
        usdDetails,
    };
}

/** Context size implied by a usage block — provider total when present, else the sum. */
export function contextTokensFromUsage(u: UsageBlock | undefined): number {
    if (!u) return 0;
    if (typeof u.totalTokens === "number" && u.totalTokens > 0) return u.totalTokens;
    return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cachedInputTokens ?? 0);
}

/**
 * Output-side USD for a usage block. Reasoning tokens ride INSIDE outputTokens
 * (AI SDK v7 contract: outputTokens = total completion tokens); most models
 * bill them at the plain output rate, but some (Qwen family) price reasoning
 * separately — when the catalog carries `cost.reasoning`, the reasoning share
 * bills at that rate and only the text share at the output rate. Pure +
 * exported for tests (no catalog needed).
 */
export function outputUsd(cost: { output: number; reasoning?: number }, usage: UsageBlock): number {
    const outTok = usage.outputTokens ?? 0;
    const reasoningTok = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? 0;
    if (cost.reasoning === undefined || reasoningTok <= 0) return (outTok / 1_000_000) * cost.output;
    // Text share: provider-reported when present; else total minus reasoning
    // (clamped — a provider that reports reasoning OUTSIDE outputTokens then
    // bills output fully + reasoning fully, which is the correct reading).
    const textTok = usage.outputTokenDetails?.textTokens ?? Math.max(0, outTok - reasoningTok);
    return (textTok / 1_000_000) * cost.output + (reasoningTok / 1_000_000) * cost.reasoning;
}

/**
 * Price a usage block against the catalog, with the per-component split.
 * Returns undefined when the model is unknown — callers decide the fallback
 * (billing treats it as $0; stamping leaves the block unstamped so a later
 * resume on a machine that DOES know the model can still price it).
 */
export function priceUsage(
    modelId: string,
    usage: UsageBlock,
): { usd: number; details: NonNullable<UsageBlock["usdDetails"]> } | undefined {
    const model = getModelSync(modelId);
    if (!model) return undefined;
    const inTok = usage.inputTokens ?? 0;
    const cacheTok = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
    const cacheWriteTok = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    const billedIn = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, inTok - cacheTok - cacheWriteTok);
    const details = {
        input: (billedIn / 1_000_000) * model.cost.input,
        // Reasoning-rate models fold the split into the output component —
        // the ledger's 4-column price snapshot stays unchanged.
        output: outputUsd(model.cost, usage),
        cacheRead: (cacheTok / 1_000_000) * model.cost.cacheRead,
        cacheWrite: (cacheWriteTok / 1_000_000) * model.cost.cacheWrite,
    };
    return { usd: details.input + details.output + details.cacheRead + details.cacheWrite, details };
}

/**
 * Stamp the billed USD (total + component split) onto a usage block before it
 * is persisted, priced with the model that actually produced it. Resume-time
 * cost seeding prefers the stamp over re-pricing, so a session's history keeps
 * its true historical cost across model switches, catalog updates, and
 * machines with a different/missing catalog. An unknown model stays unstamped
 * (fall back to catalog pricing on read, exactly the pre-stamp behavior).
 */
export function stampUsageCost(modelId: string, usage: UsageBlock): UsageBlock {
    const { provider } = parseModelId(modelId);
    const priced = priceUsage(modelId, usage);
    // openrouter reports the authoritative billed cost on the block itself
    // (includes their fee) — prefer it for the total, keep the catalog split
    // as the informational breakdown when available.
    const usd = provider === "openrouter" && typeof usage.cost === "number" ? usage.cost : priced?.usd;
    if (usd === undefined) return usage;
    return { ...usage, usd, ...(priced ? { usdDetails: priced.details } : {}) };
}

export class CostTracker {
    private session: CostBreakdown = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0 };
    /** Sticky once any estimated (interrupted-turn) usage lands in the session
     * total — drives the leading `~` in format()/sessionBreakdown(). */
    private estimated = false;
    /** Write ledger rows (default). Tests pass false so exercising add()
     * accumulates in-memory only, never touching the session DB. */
    private readonly persist: boolean;
    /** Ledger row id of the most recent add — consumed once by the persist
     * path to attach the entry that carried the same usage (attribution). */
    private lastLedgerRowId: number | undefined;

    constructor(opts: { persist?: boolean } = {}) {
        this.persist = opts.persist !== false;
    }

    /** The last add()'s ledger row id, consumed (returns undefined after). */
    takeLastLedgerRowId(): number | undefined {
        const id = this.lastLedgerRowId;
        this.lastLedgerRowId = undefined;
        return id;
    }

    private computeUsd(modelId: string, provider: string, usage: UsageBlock): number {
        // A stamped block carries the USD it was actually billed at when it
        // ran — trust it over re-pricing, which drifts with catalog changes
        // and shows $0 when the stamped model is unknown on this machine.
        if (typeof usage.usd === "number" && Number.isFinite(usage.usd)) return usage.usd;
        if (typeof usage.cost === "number" && provider === "openrouter") return usage.cost;
        return priceUsage(modelId, usage)?.usd ?? 0;
    }

    private accumulateSession(modelId: string, provider: string, usage: UsageBlock): number {
        const usd = this.computeUsd(modelId, provider, usage);
        this.session.inputTokens += usage.inputTokens ?? 0;
        this.session.outputTokens += usage.outputTokens ?? 0;
        this.session.cachedInputTokens += usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
        this.session.usd += usd;
        return usd;
    }

    /** Bill one API round-trip: accumulate in-memory + append a ledger row. */
    add(modelId: string, usage: UsageBlock, ctxOrCwd?: string | AddContext): CostBreakdown {
        this.bill(modelId, usage, ctxOrCwd, false);
        return { ...this.session };
    }

    /**
     * Bill an *estimated* usage block — the in-flight request of an
     * interrupted turn, whose real usage the AI SDK never reports
     * (vercel/ai#7805). The ledger row is flagged `estimated=1`, so the
     * session sum includes it (with the `~` prefix) while billing views
     * (lifetime/today/7d/month/cwd) exclude it.
     */
    addEstimated(modelId: string, usage: UsageBlock, ctxOrCwd?: string | AddContext): CostBreakdown {
        this.bill(modelId, usage, ctxOrCwd, true);
        this.estimated = true;
        return { ...this.session, estimated: true };
    }

    private bill(modelId: string, usage: UsageBlock, ctxOrCwd: string | AddContext | undefined, estimated: boolean) {
        // Legacy positional cwd still accepted; new callers pass the context.
        const ctx: AddContext = typeof ctxOrCwd === "string" ? { cwd: ctxOrCwd } : (ctxOrCwd ?? {});
        const { provider } = parseModelId(modelId);
        const usd = this.accumulateSession(modelId, provider, usage);
        if (!this.persist) return;
        // A failed billing write must never break a turn — but it IS a money
        // record dropping, so leave a breadcrumb (LOOP_DEBUG=1).
        try {
            this.lastLedgerRowId = addLedgerRow({
                provider,
                model: modelId,
                usage,
                usd,
                providerCost: provider === "openrouter" && typeof usage.cost === "number" ? usage.cost : undefined,
                prices: priceSnapshot(modelId),
                estimated,
                ctx: { source: ctx.source ?? "turn", cwd: ctx.cwd, sessionPub: ctx.sessionPub },
            });
        } catch (err) {
            debugLog("cost", "ledger append failed:", err as Error);
        }
    }

    stats(cwd?: string): CostStats {
        // Ledger queries see other live instances' spend by construction
        // (single WAL DB) — the cost.json refresh dance is gone. Pre-ledger
        // spend rides the frozen baseline snapshot, merged bucket-by-bucket.
        const baseline = getCostBaseline();
        const life = ledgerLifetime();
        const daily = ledgerDailyUsd();
        for (const [day, usd] of Object.entries(baseline.daily)) {
            daily.set(day, (daily.get(day) ?? 0) + usd);
        }

        const today = dayKey();
        // Walk back by calendar day, not 24h ticks — a DST-shortened day would
        // make fixed 24h steps skip (or double-count) a date key.
        const last7Keys = new Set<string>();
        const cursor = new Date();
        for (let i = 0; i < 7; i++) {
            last7Keys.add(dayKey(cursor));
            cursor.setDate(cursor.getDate() - 1);
        }
        const monthPrefix = today.slice(0, 7);

        let last7Usd = 0;
        let monthUsd = 0;
        for (const [day, usd] of daily) {
            if (last7Keys.has(day)) last7Usd += usd;
            if (day.startsWith(monthPrefix)) monthUsd += usd;
        }

        const byProvider = { ...baseline.lifetime.byProvider };
        for (const [p, usd] of Object.entries(life.byProvider)) byProvider[p] = (byProvider[p] ?? 0) + usd;

        return {
            lifetimeUsd: baseline.lifetime.usd + life.usd,
            byProvider,
            todayUsd: daily.get(today) ?? 0,
            last7Usd,
            monthUsd,
            cwdUsd: cwd ? ledgerCwdUsd(cwd) + (baseline.byCwd[cwd] ?? 0) : 0,
        };
    }

    /**
     * Rebuild session totals from a resumed transcript (assistant turns +
     * subagent runs). Session-only: lifetime/daily/cwd stores were billed
     * when those turns actually ran. Returns the last turn's token count
     * for the ctx meter.
     */
    seedFromSession(session: Session): { ctxTokens: number } {
        // Money comes from the ledger when the session has recorded rows —
        // the dollars it was billed live, never a recompute (invariant 1:
        // live total == reopened total). Sessions with no rows (imported
        // straggler, fork) fall back to the entry walk, where each usage is
        // priced with the model that produced it (stamped on the entry).
        let ledgerRows = 0;
        try {
            const sums = sumLedgerForSession(session.info.id);
            if (sums.rows > 0) {
                ledgerRows = sums.rows;
                this.reset();
                this.session = {
                    inputTokens: sums.inputTokens,
                    outputTokens: sums.outputTokens,
                    cachedInputTokens: sums.cachedInputTokens,
                    usd: sums.usd,
                };
                this.estimated = sums.estimated;
            }
        } catch (err) {
            debugLog("cost", "ledger seed failed, falling back to entries:", err as Error);
        }

        const usages: { usage: UsageBlock; model: string }[] = [];
        let lastAssistantUsage: UsageBlock | undefined;
        for (const e of session.entries()) {
            if (e.type === "message" && e.role === "assistant" && e.usage) {
                usages.push({ usage: e.usage, model: e.model ?? session.info.model });
                lastAssistantUsage = e.usage;
            } else if (e.type === "compact") {
                // The compaction replaced the context that usage measured;
                // nothing has measured the new one until the next reply.
                lastAssistantUsage = undefined;
            } else if (e.type === "subagent" && e.usage) {
                usages.push({ usage: e.usage, model: e.model ?? session.info.model });
            }
        }
        if (ledgerRows === 0) this.seedFromEntries(session.info.model, usages);
        // Ctx meter tracks the MAIN conversation: a subagent's usage counts
        // toward cost, but its context is separate — if the transcript ends on
        // a subagent entry (e.g. aborted mid-task), the meter must not adopt
        // that subagent's context size. 0 means nothing measured it — the
        // caller estimates instead.
        return { ctxTokens: contextTokensFromUsage(lastAssistantUsage) };
    }

    seedFromEntries(
        fallbackModelId: string,
        usages: UsageBlock[] | { usage: UsageBlock; model: string }[],
    ): { ctxTokens: number } {
        this.reset();
        let last: UsageBlock | undefined;
        for (const item of usages) {
            // Accept either a bare usage (legacy callers) or { usage, model }.
            const usage = "usage" in item ? item.usage : item;
            const modelId = "usage" in item ? item.model : fallbackModelId;
            const { provider } = parseModelId(modelId);
            this.accumulateSession(modelId, provider, usage);
            if (usage.estimated) this.estimated = true;
            last = usage;
        }
        return { ctxTokens: contextTokensFromUsage(last) };
    }

    sessionBreakdown(): CostBreakdown {
        return { ...this.session, estimated: this.estimated };
    }

    lifetimeBreakdown(): { usd: number; byProvider: Record<ProviderId, number> } {
        const baseline = getCostBaseline();
        const life = ledgerLifetime();
        const byProvider = { ...baseline.lifetime.byProvider };
        for (const [p, usd] of Object.entries(life.byProvider)) byProvider[p] = (byProvider[p] ?? 0) + usd;
        return { usd: baseline.lifetime.usd + life.usd, byProvider: byProvider as Record<ProviderId, number> };
    }

    reset(): void {
        this.session = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0 };
        this.estimated = false;
    }

    format(): string {
        const s = this.session;
        // Leading `~` flags that the session total includes an estimated
        // (interrupted-turn) amount, so the figure isn't read as exact.
        const prefix = this.estimated ? "~" : "";
        return `${prefix}$${s.usd.toFixed(4)} · in:${s.inputTokens} out:${s.outputTokens} cache:${s.cachedInputTokens}`;
    }
}
