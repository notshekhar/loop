/**
 * runTurn — the main agent loop: one user input driven to completion through
 * streaming, tools, hooks, persistence, and billing. Each stage lives in
 * turn/; this file only runs them in order. The provider-shaping and per-step
 * accrual it shares with runSubagent live in model-call.ts.
 */
import type { ModelMessage } from "ai";
import { getModel, isNativeAgentProvider, parseModelId } from "../providers";
import { getCatalog, modelInfoIn } from "../catalog";
import { DEFAULT_AUTO_COMPACT_THRESHOLD, getSetting } from "../settings";
import { getExtensionHost } from "../extensions";
import type { TurnContext } from "../extensions/api";
import type { ModelInfo } from "../types";
import { markTurnActive, moveMember, settleTeamTurn, teamOf } from "../teams";
import type { ThinkingLevel } from "./thinking";
import { estimateOverheadTokens } from "./model-messages";
import { buildAgentCallConfig, createStepBilling } from "./model-call";
import { withToolHooks } from "./tool-hooks";
import { isContextOverflowError, isRetryableStreamError } from "./retry";
import { applyAdditionalContext, applySystemPrompt, runAfterTurn } from "./turn-middleware";
import type { RunTurnOptions } from "./turn/types";
import {
    endTurnEarly,
    loadProjectContext,
    recordUserMessage,
    resolveAttachments,
    runPromptGates,
} from "./turn/opening";
import { assembleTurnTools } from "./turn/tools";
import { foldIntoCodeTool, isCodeModeOn } from "./turn/code-mode";
import { buildTurnSystemPrompt, notePrefixChange } from "./turn/system-prompt";
import { buildNativeAgentPrompt, forwardNativeProgress } from "./turn/native-agent";
import {
    compactBeforeFirstStep,
    commitRequestedBoundary,
    MidTurnCompaction,
    type TurnCompactionDeps,
} from "./turn/compaction";
import { createMessageBuilder } from "./turn/messages";
import { openTurnStream, turnProviderOptions, type TurnRequest } from "./turn/model-request";
import { createPrepareStep } from "./turn/step-notices";
import { StepPersister } from "./turn/step-persistence";
import { TurnStreamState } from "./turn/stream-state";
import { runStreamAttempts } from "./turn/stream-attempts";
import { saveUnfinishedTail, type TailContext } from "./turn/unfinished-tail";
import { runStopHooks, scheduleIdleCompaction, scheduleTurnRecap } from "./turn/after-turn";
import { startTeamHeartbeat, teamWatchingEmitter } from "./turn/team";

export type { RunTurnOptions } from "./turn/types";
export { stepMessagesToEntries } from "./turn/step-entries";

// AI SDK prints advisory warnings (e.g. about system messages inside the
// messages array — our deliberate Anthropic prompt-caching pattern) straight
// to the console, which tears the TUI's differential rendering. Silence them.
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

export async function runTurn(opts: RunTurnOptions): Promise<void> {
    const id = opts.session.id;
    // A Stop-hook continuation is the same turn going on; only the outermost
    // call owns the active flag (teams/runtime.ts markTurnActive).
    const outermost = (opts.hookDepth ?? 0) === 0;
    if (outermost) markTurnActive(id, true);
    const stopHeartbeat = outermost ? startTeamHeartbeat(id) : () => {};
    const startedAt = Date.now();
    let failure: string | null = null;
    try {
        // A session in no team runs exactly as it always did.
        if (!teamOf(id)) await runTurnInner(opts);
        else await runTeamTurn(opts, (message) => (failure = message));
    } catch (err) {
        failure = String(err);
        throw err;
    } finally {
        stopHeartbeat();
        if (outermost) markTurnActive(id, false);
        // Also reached by a lead whose team was created mid-turn (it spawned
        // its first threads).
        const now = outermost ? teamOf(id) : null;
        if (now) {
            settleTeamTurn(now, {
                startedAt,
                aborted: opts.abortSignal?.aborted === true,
                failure,
                ...(opts.team ? { team: opts.team } : {}),
            });
        }
    }
}

/**
 * A turn in a team member (or lead): the same turn, plus the bookkeeping the
 * team panels read — the member is "running" while it goes, and what it is
 * doing follows its tool calls.
 */
async function runTeamTurn(opts: RunTurnOptions, onError: (message: string) => void): Promise<void> {
    const id = opts.session.id;
    moveMember(id, "running", null);
    await runTurnInner({ ...opts, emitter: teamWatchingEmitter(id, opts.emitter, onError) });
}

/** Everything fixed before the first request goes out. */
interface PreparedTurn {
    provider: string;
    modelInfo: ModelInfo | undefined;
    toolsForTurn: Record<string, unknown>;
    turnContext: TurnContext;
    request: TurnRequest;
    compaction: TurnCompactionDeps;
    /** Native agents compact their own context; loop's thresholds stay informational. */
    ownsContext: boolean;
}

async function runTurnInner(opts: RunTurnOptions): Promise<void> {
    const attachments = await resolveAttachments(opts);
    const promptHooks = await runPromptGates(opts);
    if (!promptHooks) return;
    await recordUserMessage(opts);

    const turn = await prepareTurn(opts);
    if (turn.modelInfo) {
        const measured = await compactBeforeFirstStep(
            turn.compaction,
            turn.modelInfo,
            turn.ownsContext,
            turn.turnContext,
        );
        if (!measured) return endTurnEarly(opts);
        turn.turnContext = measured;
    }
    // After the boundary decision, so a reminder reads the budget the fresh
    // window actually has rather than the one that triggered the rollover.
    const extensionContext = await applyAdditionalContext(turn.turnContext);
    const injected = [promptHooks.additionalContext, extensionContext].filter(Boolean).join("\n\n");
    turn.request.providerOptions = turnProviderOptions({
        call: turn.request.call,
        provider: turn.provider,
        modelInfo: turn.modelInfo,
        session: opts.session,
        cwd: opts.cwd,
        turnContext: turn.turnContext,
    });

    const stopProgress = turn.ownsContext ? forwardNativeProgress(opts.session.id, opts.emitter) : undefined;
    let state: Awaited<ReturnType<typeof streamTurn>>;
    try {
        state = await streamTurn(opts, turn, createMessageBuilder(opts.session, attachments, injected));
    } finally {
        stopProgress?.();
    }

    scheduleTurnRecap(opts, state.assistantText, state.toolsUsed);
    scheduleIdleCompaction({
        opts,
        request: turn.request,
        provider: turn.provider,
        modelInfo: turn.modelInfo,
        ownsContext: turn.ownsContext,
        lastStepUsage: state.lastStepUsage,
        overheadTokens: turn.compaction.overheadTokens,
    });
    await runStopHooks(opts, state.assistantText, runTurn);
    // Extension turn middleware (onAfterTurn) — best-effort, never fails a turn.
    await runAfterTurn(turn.turnContext);
}

/**
 * Tools, system prompt and model for this turn. The system prompt is built
 * AFTER the tools are assembled so the tool list it describes matches reality.
 */
async function prepareTurn(opts: RunTurnOptions): Promise<PreparedTurn> {
    const { session, modelId, cwd } = opts;
    const { provider, model: modelShortId } = parseModelId(modelId);
    const modelInfo = modelInfoIn(await getCatalog(), modelId);
    const project = await loadProjectContext(cwd);
    const assembled = await assembleTurnTools(opts, {
        provider,
        modelShortId,
        workspaceContext: project.workspaceContext,
        // Subagents get the read-tool wording (task tool forwards this): the
        // skill tool is parent-only, but skill files are readable everywhere.
        skillsPrompt: project.skillsPrompt,
        skills: project.skills,
    });
    const { toolsForTurn, turnContext } = assembled;
    const hookCtx = {
        cwd,
        sessionId: session.id,
        transcriptPath: session.path,
        emitter: opts.emitter,
        turnContext,
        // Empty when no extensions are loaded → withToolHooks is a pass-through.
        callMiddleware: getExtensionHost().getToolCallMiddleware(),
        resultMiddleware: getExtensionHost().getToolResultMiddleware(),
    };
    const hooked = withToolHooks(toolsForTurn as typeof assembled.fullToolSet, hookCtx);
    // What the model is offered: the hooked tools, or in Code Mode the direct
    // ones plus `code`. Everything sized or hashed from "the tools" uses this.
    const codeMode = isCodeModeOn(provider);
    const tools = codeMode
        ? ((await foldIntoCodeTool(hooked, {
              emitter: opts.emitter,
              session,
              abortSignal: opts.abortSignal,
              wrap: (t) => withToolHooks(t, hookCtx),
          })) as typeof hooked)
        : hooked;
    // Extension middleware may transform the system prompt, scoped by ctx.agent.
    // The prompt still names every tool: in Code Mode they are called from scripts.
    const ownsContext = isNativeAgentProvider(provider);
    const system = await applySystemPrompt(
        ownsContext
            ? buildNativeAgentPrompt(provider, cwd, project)
            : buildTurnSystemPrompt(toolsForTurn, { ...project, cwd, agentPrompt: assembled.agentPrompt, codeMode }),
        turnContext,
    );
    notePrefixChange(session.id, system, tools);
    const thinkingLevel: ThinkingLevel = opts.thinkingLevel ?? getSetting("thinkingLevel") ?? "off";
    // Shared provider shaping (see model-call.ts), matching runSubagent by construction.
    const call = buildAgentCallConfig({ provider, modelShortId, thinkingLevel, modelInfo });
    const model = await getModel(modelId);
    return {
        provider,
        modelInfo,
        toolsForTurn,
        turnContext,
        request: { model, system, tools, call, providerOptions: call.providerOptions },
        compaction: {
            session,
            modelId,
            cwd,
            emitter: opts.emitter,
            tracker: opts.tracker,
            abortSignal: opts.abortSignal,
            thinkingLevel: opts.thinkingLevel,
            overheadTokens: estimateOverheadTokens(system, tools),
            threshold: getSetting("autoCompactThreshold") ?? DEFAULT_AUTO_COMPACT_THRESHOLD,
        },
        ownsContext,
    };
}

/**
 * Step cap is only an upper safety bound — the loop ends naturally when the
 * model returns no tool call. 0 / unset means "run until the model decides".
 */
function resolveMaxSteps(opts: RunTurnOptions): number {
    const configured = opts.maxSteps ?? getSetting("maxSteps") ?? 0;
    return configured > 0 ? configured : Number.MAX_SAFE_INTEGER;
}

/** Stream the turn to its end, then save whatever the last step left unsaved. */
async function streamTurn(
    opts: RunTurnOptions,
    turn: PreparedTurn,
    buildMessages: () => ModelMessage[],
): Promise<TurnStreamState> {
    const { session, modelId, cwd, abortSignal, tracker, emitter } = opts;
    const ledgerSource = opts.team ? "team" : "turn";
    const billing = createStepBilling(tracker, modelId, { cwd, sessionPub: session.info.id, source: ledgerSource });
    const persister = new StepPersister(session, modelId, billing);
    const midTurn = new MidTurnCompaction(
        turn.modelInfo !== undefined && !turn.ownsContext,
        session,
        turn.modelInfo,
        turn.compaction,
    );
    const overflow = { recovered: false };
    const state = new TurnStreamState(
        emitter,
        billing,
        persister,
        // Not reported yet: the attempt loop may still recover from it.
        (err) => isRetryableStreamError(err) || (!overflow.recovered && isContextOverflowError(err)),
        () => midTurn.dueAt !== undefined,
    );
    const hooks = {
        toolsForTurn: turn.toolsForTurn,
        prepareStep: createPrepareStep({
            session,
            emitter,
            persister,
            toolsForTurn: turn.toolsForTurn,
            basePrepareStep: turn.request.call.prepareStep,
        }),
        midTurn,
        timing: persister.timing,
        persistStep: (step: Parameters<StepPersister["persistStep"]>[0]) => void persister.persistStep(step),
        abortSignal,
    };
    await runStreamAttempts({
        state,
        persister,
        midTurn,
        compaction: turn.compaction,
        modelInfo: turn.modelInfo,
        emitter,
        abortSignal,
        maxSteps: resolveMaxSteps(opts),
        buildMessages,
        openStream: (messages, remainingSteps) => openTurnStream(turn.request, hooks, messages, remainingSteps),
        overflow,
    });
    await settleTranscript(opts, turn, { billing, ledgerSource, state, persister });
    return state;
}

/**
 * Leave the session complete and ordered: drain the step queue, save the
 * interrupted step's tail, then — last, so its cutAt sees every entry — any
 * new_context the model asked for.
 */
async function settleTranscript(
    opts: RunTurnOptions,
    turn: PreparedTurn,
    stream: Pick<TailContext, "billing" | "ledgerSource" | "state" | "persister">,
): Promise<void> {
    const { session, modelId, cwd, tracker, emitter } = opts;
    await stream.persister.flush();
    const aborted = opts.abortSignal?.aborted === true;
    const overheadTokens = turn.compaction.overheadTokens;
    await saveUnfinishedTail({ session, modelId, cwd, tracker, emitter, overheadTokens, ...stream }, aborted);
    await commitRequestedBoundary(session, emitter, overheadTokens, aborted);
}
