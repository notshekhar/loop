/** What a finished turn leaves behind: a recap, an idle compaction, and Stop hooks. */
import { generateText, type ModelMessage } from "ai";
import { getSetting } from "../../settings";
import type { Session } from "../../sessions";
import type { ModelInfo, UsageBlock } from "../../types";
import { runCompact } from "../compact";
import { contextTokensFromUsage } from "../cost";
import { runHooks } from "../hooks";
import {
    DEFAULT_IDLE_COMPACT_MIN_PERCENT,
    IDLE_SUMMARY_INSTRUCTIONS,
    idleCompactDelayMs,
    scheduleIdleCompact,
} from "../idle-compact";
import { estimateContextTokens, toModelMessages } from "../model-messages";
import { runRecap, turnDeservesRecap } from "../recap";
import { scheduleRecap } from "../recap-schedule";
import { failedCompactEnd } from "./compaction";
import { requestBase, type TurnRequest } from "./model-request";
import { forwardHookOutput } from "./opening";
import type { RunTurnOptions } from "./types";

/** Stop-hook continuations deeper than this are dropped, so hooks can't loop forever. */
const MAX_STOP_HOOK_DEPTH = 3;

/** Cap on the reply handed to Stop hooks — it rides a stdin pipe to every one of them. */
const STOP_HOOK_MESSAGE_CHARS = 4_000;

/**
 * Post-turn recap: only for turns that wrote/edited files, detached so the
 * prompt frees immediately. It waits out RECAP_DELAY_MS and the next turn
 * cancels it (see recap-schedule.ts), so a user who replies straight away
 * never pays for a summary of the turn they just moved past. Skipped for hook
 * continuations (the final continuation recaps the whole turn).
 */
export function scheduleTurnRecap(opts: RunTurnOptions, assistantText: string, toolsUsed: string[]): void {
    const recapEnabled = opts.recap ?? getSetting("recap") === true;
    const recapWorthy = turnDeservesRecap(toolsUsed) && assistantText.trim() !== "";
    if (!recapEnabled || !recapWorthy || (opts.hookDepth ?? 0) !== 0 || opts.abortSignal?.aborted) return;
    const { session, modelId, userInput, tracker, cwd, emitter } = opts;
    scheduleRecap(session.id, async (signal) => {
        // The recap's own signal, not the turn's: the turn is over by the time
        // this runs, and what must be able to cancel it now is the NEXT turn.
        const text = await runRecap({
            session,
            modelId,
            userInput,
            assistantText,
            toolsUsed,
            tracker,
            cwd,
            abortSignal: signal,
        }).catch(() => ""); // best-effort — a failed recap never fails the turn
        if (text && !signal.aborted) emitter.emit("data-recap", { text });
    });
}

export interface IdleCompactionInput {
    opts: RunTurnOptions;
    request: TurnRequest;
    provider: string;
    modelInfo: ModelInfo | undefined;
    /** Native agents compact their own context; loop leaves it alone. */
    ownsContext: boolean;
    lastStepUsage: UsageBlock | undefined;
    overheadTokens: number;
}

/**
 * Idle compaction (idle-compact.ts): a big conversation is summarized just
 * before its prompt cache lapses, if nobody sends anything first. The request
 * is this turn's own — same system prompt, same tools (never called), same
 * provider options — with one message appended, so the provider reads the
 * conversation from cache instead of at full price.
 */
export function scheduleIdleCompaction(input: IdleCompactionInput): void {
    const { opts, modelInfo } = input;
    const idleDelay = idleCompactDelayMs({
        provider: input.provider,
        anthropicCaching: input.request.call.anthropicCaching,
    });
    if (
        idleDelay === null ||
        getSetting("idleCompact") === false ||
        (opts.hookDepth ?? 0) !== 0 ||
        opts.abortSignal?.aborted ||
        input.ownsContext ||
        !modelInfo
    ) {
        return;
    }
    const minPercent = getSetting("idleCompactMinPercent") ?? DEFAULT_IDLE_COMPACT_MIN_PERCENT;
    const used =
        contextTokensFromUsage(input.lastStepUsage) || estimateContextTokens(opts.session, input.overheadTokens);
    if (used < modelInfo.contextWindow * (minPercent / 100)) return;
    scheduleIdleCompact(opts.session.id, idleDelay, (signal) =>
        runIdleCompaction(input, modelInfo.contextWindow, used, signal),
    );
}

async function runIdleCompaction(
    input: IdleCompactionInput,
    contextWindow: number,
    used: number,
    signal: AbortSignal,
): Promise<void> {
    const { session, modelId, tracker, cwd, emitter } = input.opts;
    emitter.emit("compact-start", { reason: "idle" });
    try {
        const result = await runCompact({
            session,
            modelId,
            tracker,
            cwd,
            contextWindow,
            abortSignal: signal,
            trigger: "idle",
            summarize: () => summarizeFromCache(input.request, session, signal),
        });
        emitter.emit("compact-end", result);
    } catch (err) {
        // Cancelled because the user came back: not news.
        emitter.emit("compact-end", failedCompactEnd(used, signal.aborted, err));
    }
}

async function summarizeFromCache(request: TurnRequest, session: Session, signal: AbortSignal) {
    const conversation: ModelMessage[] = [
        ...toModelMessages(session),
        { role: "user", content: IDLE_SUMMARY_INSTRUCTIONS },
    ];
    const out = await generateText({ ...requestBase(request, conversation), toolChoice: "none", abortSignal: signal });
    return { text: out.text, usage: out.usage as UsageBlock, finishReason: out.finishReason };
}

/**
 * Stop hooks: a block sends the reason back as a follow-up turn so the agent
 * keeps working (Claude Code parity, e.g. "tests must pass").
 */
export async function runStopHooks(
    opts: RunTurnOptions,
    assistantText: string,
    continueTurn: (opts: RunTurnOptions) => Promise<void>,
): Promise<void> {
    if (opts.abortSignal?.aborted) return;
    const hookDepth = opts.hookDepth ?? 0;
    const { session } = opts;
    const stopHooks = await runHooks(
        "Stop",
        undefined,
        {
            session_id: session.id,
            transcript_path: session.path,
            // Mirrors Claude Code: true when this turn is already a stop-hook
            // continuation, so ported hooks can use it as their loop guard.
            stop_hook_active: hookDepth > 0,
            // Beyond Claude Code's payload: what the agent actually said. Every
            // "the turn is done" watcher wants to show it (cmux's completion
            // notification is one), and the turn is holding the text right here.
            last_assistant_message: assistantText.trim().slice(0, STOP_HOOK_MESSAGE_CHARS) || undefined,
        },
        opts.cwd,
    );
    forwardHookOutput(opts, stopHooks);
    if (stopHooks.block && hookDepth < MAX_STOP_HOOK_DEPTH) {
        opts.emitter.emit("hook-message", `stop hook requested continuation: ${stopHooks.reason}`);
        await continueTurn({ ...opts, userInput: `[stop hook] ${stopHooks.reason}`, hookDepth: hookDepth + 1 });
    }
}
