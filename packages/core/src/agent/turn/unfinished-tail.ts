/**
 * Saving what streamed after the last FINISHED step. Finished steps already
 * persisted (onStepEnd) and billed (finish-step usage) their own content, so
 * the tail is exactly the interrupted step's partial output — nothing
 * finished is lost or duplicated.
 */
import { stampUsageCost, type CostTracker } from "../cost";
import type { TurnEmitter } from "../events";
import type { StepBilling } from "../model-call";
import { attachLedgerEntry, type Session } from "../../sessions";
import type { Entry, UsageBlock } from "../../types";
import { estimateInterruptedUsage, lastUsageInSession } from "./interrupted-usage";
import type { StepPersister } from "./step-persistence";
import type { TurnStreamState } from "./stream-state";

type TailPart = { type: "reasoning"; text: string } | { type: "text"; text: string };

export interface TailContext {
    session: Session;
    modelId: string;
    cwd: string;
    tracker: CostTracker;
    emitter: TurnEmitter;
    billing: StepBilling;
    ledgerSource: "team" | "turn";
    overheadTokens: number;
    state: TurnStreamState;
    persister: StepPersister;
}

/**
 * Reasoning is kept (an interrupt during the thinking phase still records
 * what it produced) and the answer text after it.
 */
function tailParts(state: TurnStreamState): TailPart[] {
    const parts: TailPart[] = [];
    if (state.reasoningSinceStep.trim() !== "") parts.push({ type: "reasoning", text: state.reasoningSinceStep });
    if (state.textSinceStep.trim() !== "") parts.push({ type: "text", text: state.textSinceStep });
    return parts;
}

export async function saveUnfinishedTail(ctx: TailContext, aborted: boolean): Promise<void> {
    const parts = tailParts(ctx.state);
    if (aborted) await saveInterruptedTurn(ctx, parts);
    else if (!ctx.persister.persistedAnyMessage && (parts.length > 0 || ctx.state.lastUsage || ctx.billing.sum)) {
        await saveStreamEdge(ctx, parts);
    }
}

/**
 * Persist the interrupted turn so the transcript AND the next turn's context
 * both reflect it. `interrupted: true` makes toModelMessages append a note
 * (and never silently drop an empty aborted turn). Only text/usage here —
 * never a tool call without its result, so there's no orphaned tool_use to
 * break the next turn. A native agent's completed calls are the exception:
 * its provider ran them, each already has its result, and its one step is
 * the turn.
 */
async function saveInterruptedTurn(ctx: TailContext, parts: TailPart[]): Promise<void> {
    const { state, session, modelId } = ctx;
    const nativeTail = state.providerTail.content();
    const streamedTail = parts.length > 0 || nativeTail !== undefined;
    const est = streamedTail ? billInterruptedStep(ctx) : undefined;
    if (streamedTail || !ctx.persister.persistedAnyMessage) {
        const inFlight = ctx.persister.timing.closeInFlight();
        const entry: Entry = {
            type: "message",
            ts: Date.now(),
            role: "assistant",
            content: nativeTail ?? (parts.length > 0 ? parts : ""),
            interrupted: true,
            ...(inFlight ? { timing: inFlight } : {}),
            ...(est ? { usage: stampUsageCost(modelId, est), model: modelId } : {}),
        };
        await session.append(entry);
        const estRowId = ctx.tracker.takeLastLedgerRowId();
        if (est && estRowId !== undefined && entry.id) attachLedgerEntry(estRowId, entry.id);
    }
    // The AI SDK skips its stream `finish` part on abort (see model-call.ts).
    // RPC/web clients clear "running" on finish — without this, Stop looks
    // broken and the composer stays locked.
    state.finishOnce(undefined);
}

/**
 * Estimate the interrupted request's usage — the SDK reports none on abort
 * (vercel/ai#7805). Input is anchored to the adjacent real step (this turn's
 * last, or the previous turn's); only the small output tail is approximated.
 * Session total only (never the persistent cost store), shown with `~`.
 */
function billInterruptedStep(ctx: TailContext): UsageBlock | undefined {
    const { state, session } = ctx;
    const est = estimateInterruptedUsage(
        state.textSinceStep,
        state.reasoningSinceStep,
        state.lastStepUsage ?? lastUsageInSession(session),
        session,
        ctx.overheadTokens,
    );
    if (!est) return undefined;
    ctx.tracker.addEstimated(ctx.modelId, est, { cwd: ctx.cwd, sessionPub: session.info.id, source: ctx.ledgerSource });
    ctx.emitter.emit("step-usage", { usage: est, breakdown: ctx.tracker.sessionBreakdown() });
    return est;
}

/**
 * The stream ended without any step persisting (e.g. a provider error after
 * partial output). Keep what streamed, with the real usage we did capture.
 */
async function saveStreamEdge(ctx: TailContext, parts: TailPart[]): Promise<void> {
    const usage = ctx.state.lastUsage ?? ctx.billing.sum;
    const inFlight = ctx.persister.timing.closeInFlight();
    await ctx.session.append({
        type: "message",
        ts: Date.now(),
        role: "assistant",
        content: parts.length > 0 ? parts : "",
        ...(inFlight ? { timing: inFlight } : {}),
        usage: usage ? stampUsageCost(ctx.modelId, usage) : undefined,
        model: ctx.modelId,
    });
}
