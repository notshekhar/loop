/**
 * The turn's attempt loop. One iteration = one stream; a turn reopens its
 * stream when compaction is due between steps, when the provider refuses the
 * request as too big, or when a transient failure kills it between steps.
 * Everything the streams accumulate lives in TurnStreamState, so every
 * reopened stream continues the same turn.
 */
import type { ModelMessage } from "ai";
import { getSetting } from "../../settings";
import type { ModelInfo } from "../../types";
import { debugLog } from "../../debug";
import { isAbortError } from "../abort";
import { createYieldGate } from "../model-call";
import {
    abortableDelay,
    DEFAULT_MAX_STREAM_RESUMES,
    describeRetry,
    isContextOverflowError,
    resumeDelayMs,
} from "../retry";
import type { TurnEmitter } from "../events";
import { estimateContextTokens } from "../model-messages";
import { compactOverThreshold, type MidTurnCompaction, type TurnCompactionDeps } from "./compaction";
import type { StepPersister } from "./step-persistence";
import type { TurnStreamState } from "./stream-state";
import type { openTurnStream } from "./model-request";

type StreamResult = ReturnType<typeof openTurnStream>;

export interface AttemptLoop {
    state: TurnStreamState;
    persister: StepPersister;
    midTurn: MidTurnCompaction;
    compaction: TurnCompactionDeps;
    modelInfo: ModelInfo | undefined;
    emitter: TurnEmitter;
    abortSignal?: AbortSignal;
    maxSteps: number;
    buildMessages: () => ModelMessage[];
    openStream: (messages: ModelMessage[], remainingSteps: number) => StreamResult;
    /** Overflow recovery runs once per turn; see recoverFromOverflow. */
    overflow: { recovered: boolean };
}

/** What to do after a stream ends. */
type Next = "continue" | "stop";

export async function runStreamAttempts(loop: AttemptLoop): Promise<void> {
    const { state, maxSteps } = loop;
    // 0 disables resuming (the first error ends the turn).
    const maxResumes = Math.max(0, getSetting("maxStreamResumes") ?? DEFAULT_MAX_STREAM_RESUMES);
    // Lets the TUI's render timers fire between bursts of buffered parts —
    // see model-call.ts for the starvation rationale.
    const maybeYield = createYieldGate();
    let messages = loop.buildMessages();
    let resumes = 0;
    for (;;) {
        state.streamError = undefined;
        const stream = loop.openStream(messages, Math.max(1, maxSteps - state.stepsDone));
        await consumeStream(loop, stream, maybeYield);

        const afterOverflow = await recoverFromOverflow(loop);
        if (afterOverflow === "stop") return;
        if (afterOverflow === "continue") {
            messages = loop.buildMessages();
            continue;
        }
        const afterCompaction = await compactMidTurn(loop);
        if (afterCompaction === "stop") return;
        if (afterCompaction === "continue") {
            messages = loop.buildMessages();
            continue;
        }
        if (!canResume(loop, resumes, maxResumes)) {
            giveUp(loop);
            return;
        }
        resumes++;
        if ((await waitToResume(loop, resumes, maxResumes)) === "stop") return;
        messages = loop.buildMessages();
    }
}

/**
 * Drain one stream into the turn state. The interrupt can land between parts
 * (the `break`) or while awaiting the next part: a real fetch-backed provider
 * rejects its body stream on abort, which can throw straight out of
 * `for await` and would skip the persistence after it, losing the partial
 * reply. So aborts are swallowed here; any other unrecoverable error still
 * propagates.
 */
async function consumeStream(loop: AttemptLoop, result: StreamResult, maybeYield: () => Promise<void>): Promise<void> {
    const { state, abortSignal } = loop;
    try {
        for await (const part of result.stream) {
            if (abortSignal?.aborted) break;
            state.handlePart(part as never);
            await maybeYield();
        }
    } catch (err) {
        if (isAbortError(err) || abortSignal?.aborted) return;
        if (!state.noteThrown(err)) throw err;
    }
}

/**
 * The provider refused the request as too big for its window: the estimate
 * ran low, or one tool result was enormous. Compact what the finished steps
 * left and retry — only when nothing of the failed step has streamed (the
 * same rule a resume follows, or it would repeat), and once per turn: a
 * second refusal right after means the kept window alone is too big.
 * undefined = not an overflow, carry on deciding.
 */
async function recoverFromOverflow(loop: AttemptLoop): Promise<Next | undefined> {
    const { state, overflow } = loop;
    const refused = state.streamError;
    if (
        refused === undefined ||
        overflow.recovered ||
        !isContextOverflowError(refused) ||
        loop.abortSignal?.aborted ||
        state.tailStreamed
    ) {
        return undefined;
    }
    overflow.recovered = true;
    await loop.persister.flush();
    const used = estimateContextTokens(loop.compaction.session, loop.compaction.overheadTokens);
    const outcome = await compactOverThreshold(
        loop.compaction,
        used,
        loop.modelInfo?.contextWindow ?? used,
        "overflow",
    );
    if (outcome === "aborted") return "stop";
    if (outcome === "compacted") {
        state.streamError = undefined;
        state.pendingFinish = undefined;
        return "continue";
    }
    // Nothing freed: the refusal is reported exactly as it came.
    return undefined;
}

/**
 * The stream stopped itself at a finished step, so everything it did is
 * persisted once the queue drains, and a fresh stream over the compacted
 * session continues the turn. Not a resume: no backoff, and it spends nothing
 * from the resume allowance. undefined = no compaction was due.
 */
async function compactMidTurn(loop: AttemptLoop): Promise<Next | undefined> {
    const { state, modelInfo } = loop;
    const used = loop.midTurn.take();
    if (used === undefined) return undefined;
    if (modelInfo && state.streamError === undefined && !loop.abortSignal?.aborted && state.stepsDone < loop.maxSteps) {
        state.compactionFinish = undefined;
        await loop.persister.flush();
        const outcome = await compactOverThreshold(loop.compaction, used, modelInfo.contextWindow, "mid-turn");
        if (outcome === "aborted") return "stop";
        if (outcome === "declined") loop.midTurn.disable();
        return "continue";
    }
    if (state.compactionFinish) state.finishOnce(state.compactionFinish.usage);
    return undefined;
}

/**
 * Reopen the stream only when the failure landed BETWEEN steps: the finished
 * steps are persisted, so a fresh stream over them continues the turn. With
 * an un-persisted tail in flight the model would regenerate that step and the
 * user would see the text twice — so that case reports the error instead.
 */
function canResume(loop: AttemptLoop, resumes: number, maxResumes: number): boolean {
    const { state } = loop;
    return (
        state.streamError !== undefined &&
        !state.sawFinish &&
        !loop.abortSignal?.aborted &&
        !state.tailStreamed &&
        resumes < maxResumes &&
        state.stepsDone < loop.maxSteps
    );
}

/**
 * Report only THIS attempt's failure — a held-back error from an earlier
 * attempt that we then recovered from is not news. Then the finish we
 * withheld, so a finish-keyed consumer (an RPC client) still sees exactly
 * one end event.
 */
function giveUp(loop: AttemptLoop): void {
    const { state } = loop;
    if (state.streamError !== undefined) loop.emitter.emit("error", state.streamError);
    if (state.pendingFinish) state.finishOnce(state.pendingFinish.usage);
}

async function waitToResume(loop: AttemptLoop, resumes: number, maxResumes: number): Promise<Next> {
    const { state, abortSignal } = loop;
    state.pendingFinish = undefined;
    loop.emitter.emit("stream-retry", {
        attempt: resumes,
        max: maxResumes,
        reason: describeRetry(state.streamError),
        stepsDone: state.stepsDone,
    });
    debugLog("retry", `stream failed after ${state.stepsDone} step(s), resume ${resumes}/${maxResumes}`);
    // Let the finished steps land before rebuilding the conversation from
    // them — otherwise the resumed stream re-asks the last question.
    await loop.persister.flush();
    const waitFrom = Date.now();
    await abortableDelay(resumeDelayMs(resumes - 1), abortSignal);
    loop.persister.timing.retryWaited(Date.now() - waitFrom);
    return abortSignal?.aborted ? "stop" : "continue";
}
