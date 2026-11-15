/**
 * Compaction inside a turn: before the first step, between steps (mid-turn),
 * after an overflow refusal, and the model's own new_context request at the
 * end. Idle compaction after the turn lives in after-turn.ts.
 */
import type { Session } from "../../sessions";
import type { ModelInfo, UsageBlock } from "../../types";
import { runCompact } from "../compact";
import type { TurnContext } from "../../extensions/api";
import { clearContextBoundary, decideContextAction, setContextBudget, takeContextBoundary } from "../context-policy";
import { contextTokensFromUsage, type CostTracker } from "../cost";
import type { TurnEmitter } from "../events";
import { runHooks } from "../hooks";
import { estimateContextTokens } from "../model-messages";
import { buildRolloverHandoff, MAX_HANDOFF_CHARS as MAX_EXPLICIT_HANDOFF_CHARS, MIN_USABLE_TOKENS } from "../rollover";
import type { ThinkingLevel } from "../thinking";

export type CompactionReason = "threshold" | "mid-turn" | "overflow";
export type CompactionOutcome = "compacted" | "declined" | "aborted";

export interface TurnCompactionDeps {
    session: Session;
    modelId: string;
    cwd: string;
    emitter: TurnEmitter;
    tracker: CostTracker;
    abortSignal?: AbortSignal;
    thinkingLevel?: ThinkingLevel;
    /** System prompt + tool schemas: billed context that never appears in the session. */
    overheadTokens: number;
    /** Share of the window that triggers compaction. */
    threshold: number;
}

/** chars/4 — loop's house token heuristic for a handoff that was never sent. */
const handoffTokens = (handoff: string) => Math.ceil(handoff.length / 4);

/**
 * The context crossed the threshold: let the context policy choose between a
 * rollover and a summary, and carry it out.
 *
 * A failed summary is reported and survived rather than thrown — the request
 * may well still fit, and if it doesn't the provider says so in plainer words
 * than a dead turn would.
 */
export async function compactOverThreshold(
    deps: TurnCompactionDeps,
    usedTokens: number,
    contextWindow: number,
    reason: CompactionReason,
): Promise<CompactionOutcome> {
    const decision = await decideContextAction({
        session: deps.session,
        modelId: deps.modelId,
        cwd: deps.cwd,
        usedTokens,
        contextWindow,
        overheadTokens: deps.overheadTokens,
        thresholdTokens: Math.floor(contextWindow * deps.threshold),
        reason,
    });
    if (decision.kind === "none") return "declined";
    if (decision.kind === "rollover") {
        await autoRollover(deps, { handoff: decision.handoff, cutAt: decision.cutAt, tokensBefore: usedTokens });
        return "compacted";
    }
    return summarize(deps, usedTokens, contextWindow);
}

interface Rollover {
    handoff: string;
    cutAt: number;
    tokensBefore: number;
}

/**
 * No model call, so no spend and nothing to abort — the entry is the whole
 * operation. Emitted through the same events as a compaction so every
 * surface keeps one code path.
 */
async function autoRollover(deps: TurnCompactionDeps, rollover: Rollover): Promise<void> {
    deps.emitter.emit("compact-start", { reason: "auto", mode: "rollover" });
    await runPreCompactHook(deps, "rollover");
    await commitRollover(deps.session, deps.emitter, rollover);
}

async function commitRollover(session: Session, emitter: TurnEmitter, rollover: Rollover): Promise<void> {
    const { handoff, cutAt, tokensBefore } = rollover;
    const tokensAfter = handoffTokens(handoff);
    await session.append({
        type: "compact",
        ts: Date.now(),
        summary: "",
        handoff,
        rollover: true,
        cutAt,
        tokensBefore,
        tokensAfter,
    });
    emitter.emit("compact-end", { summary: "", handoff, mode: "rollover", cutAt, tokensBefore, tokensAfter });
}

/** PreCompact is informational for watchers — block is ignored. */
async function runPreCompactHook(deps: TurnCompactionDeps, trigger: "auto" | "rollover"): Promise<void> {
    const { session } = deps;
    await runHooks("PreCompact", "auto", { session_id: session.id, transcript_path: session.path, trigger }, deps.cwd);
}

async function summarize(
    deps: TurnCompactionDeps,
    usedTokens: number,
    contextWindow: number,
): Promise<CompactionOutcome> {
    deps.emitter.emit("compact-start", { reason: "auto" });
    await runPreCompactHook(deps, "auto");
    try {
        const result = await runCompact({
            session: deps.session,
            modelId: deps.modelId,
            abortSignal: deps.abortSignal,
            tracker: deps.tracker,
            cwd: deps.cwd,
            contextWindow,
            ...(deps.thinkingLevel ? { thinkingLevel: deps.thinkingLevel } : {}),
        });
        deps.emitter.emit("compact-end", result);
        return result.cutAt > 0 ? "compacted" : "declined";
    } catch (err) {
        const aborted = deps.abortSignal?.aborted === true;
        deps.emitter.emit("compact-end", failedCompactEnd(usedTokens, aborted, err));
        return aborted ? "aborted" : "declined";
    }
}

/** The compact-end of a summary that did not happen. */
export function failedCompactEnd(tokensBefore: number, aborted: boolean, err: unknown) {
    return {
        summary: "",
        cutAt: 0,
        tokensBefore,
        ...(aborted ? { aborted: true } : { error: err instanceof Error ? err.message : String(err) }),
    };
}

type CompactionStepView = {
    usage?: UsageBlock;
    toolCalls: ReadonlyArray<unknown>;
    toolResults: ReadonlyArray<{ output?: unknown }>;
};

/**
 * Mid-turn compaction. The check before the first step runs once, so a long
 * tool-heavy turn could climb from 30% to past the window without being
 * looked at again. After every step that leads to another (it made tool
 * calls), measure what the NEXT request will carry — this step's context per
 * the provider, plus the tool results it produced — and over the threshold,
 * stop the stream at this clean boundary. The attempt loop then compacts and
 * reopens it, the same way a resume does.
 *
 * One declined or failed attempt switches it off for the rest of the turn: a
 * compaction that frees nothing would otherwise fire after every step.
 */
export class MidTurnCompaction {
    /** Set when the stream was stopped for compaction: the tokens the next request would carry. */
    dueAt: number | undefined;

    constructor(
        private enabled: boolean,
        private readonly session: Session,
        private readonly modelInfo: ModelInfo | undefined,
        private readonly deps: Pick<TurnCompactionDeps, "overheadTokens" | "threshold">,
    ) {}

    disable(): void {
        this.enabled = false;
    }

    /** Takes the due mark, so it is acted on once. */
    take(): number | undefined {
        const due = this.dueAt;
        this.dueAt = undefined;
        return due;
    }

    /** A streamText stop condition. */
    readonly isDue = ({ steps }: { steps: ReadonlyArray<CompactionStepView> }): boolean => {
        const step = steps.at(-1);
        if (!this.enabled || !this.modelInfo || !step || step.toolCalls.length === 0) return false;
        const fromUsage = contextTokensFromUsage(step.usage);
        const context = fromUsage > 0 ? fromUsage : estimateContextTokens(this.session, this.deps.overheadTokens);
        const next = context + Math.ceil(JSON.stringify(step.toolResults.map((r) => r.output)).length / 4);
        if (next <= this.modelInfo.contextWindow * this.deps.threshold) return false;
        this.dueAt = next;
        return true;
    };
}

/**
 * An explicit new_context lands after every other entry of the turn: the
 * interrupt and stream-edge entries still append late, and a boundary
 * committed before them would compute cutAt against an incomplete message
 * list — leaving this turn's own final assistant message stranded above its
 * own boundary. An aborted turn drops the request instead: the user pressed
 * Ctrl+C, and throwing away their context is not what they asked for. The
 * model can ask again next turn.
 */
export async function commitRequestedBoundary(
    session: Session,
    emitter: TurnEmitter,
    overheadTokens: number,
    aborted: boolean,
): Promise<void> {
    const boundary = takeContextBoundary();
    if (!boundary) return;
    if (aborted) {
        clearContextBoundary();
        return;
    }
    const cutAt = session.messages().length;
    const handoff =
        boundary.handoff?.trim() ||
        buildRolloverHandoff(session.getBranch(), { limit: MAX_EXPLICIT_HANDOFF_CHARS }) ||
        "";
    if (!handoff) return;
    emitter.emit("compact-start", { reason: "manual", mode: "rollover" });
    await commitRollover(session, emitter, {
        handoff,
        cutAt,
        tokensBefore: estimateContextTokens(session, overheadTokens),
    });
}

/**
 * Publish this turn's context budget and, over the threshold, compact before
 * the first step. Runs once the system prompt is final, so the estimate counts
 * the system prompt + tool definitions of THIS turn — never in the session,
 * but billed context all the same. Returns the context with its usage filled
 * in, or null when the user aborted the compaction (the turn is then over).
 *
 * Native agents compact their own context inside their own session; a
 * loop-side compaction would only rewrite what loop shows and force a
 * re-seed, so loop's thresholds stay informational for them.
 */
export async function compactBeforeFirstStep(
    deps: TurnCompactionDeps,
    modelInfo: ModelInfo,
    ownsContext: boolean,
    turnContext: TurnContext,
): Promise<TurnContext | null> {
    const window = modelInfo.contextWindow;
    const tokens = estimateContextTokens(deps.session, deps.overheadTokens);
    const rolloverAt = Math.floor(window * deps.threshold);
    setContextBudget({
        used: tokens,
        window,
        rolloverAt,
        supported: rolloverAt - deps.overheadTokens >= MIN_USABLE_TOKENS,
    });
    if (!ownsContext && tokens > window * deps.threshold) {
        if ((await compactOverThreshold(deps, tokens, window, "threshold")) === "aborted") return null;
    }
    // Usage is only knowable here — anything reading it earlier undercounts
    // by the whole system block.
    return { ...turnContext, contextUsed: tokens, contextWindow: window };
}
