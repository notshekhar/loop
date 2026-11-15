/**
 * The request a turn sends: model, system prompt, tools and provider shaping,
 * fixed once per turn. Both the turn's stream and the idle-compaction summary
 * (after-turn.ts) are built from it, so the summary reads the conversation
 * from the provider's cache instead of at full price.
 */
import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { getModel, isNativeAgentProvider, type NativeAgentTurnContext } from "../../providers";
import { getSetting } from "../../settings";
import { getBashApprovalBridge, isPlanModeActive, planDeliveredThisStep, PLAN_TOOL_NAME } from "../../tools";
import { REPORT_TOOL } from "../../teams";
import type { TurnContext } from "../../extensions/api";
import type { Session } from "../../sessions";
import type { ModelInfo } from "../../types";
import { withAnthropicCaching } from "../model-messages";
import { withOllamaContext, type AgentCallConfig } from "../model-call";
import { applyProviderOptions } from "../turn-middleware";
import type { StepTimingRecorder } from "../step-timing";
import type { MidTurnCompaction } from "./compaction";
import type { FinishedStep } from "./step-persistence";
import type { PrepareStep } from "./step-notices";
import { reportedThisStep } from "./team";

export interface TurnRequest {
    model: Awaited<ReturnType<typeof getModel>>;
    system: string;
    /** The assembled tools, wrapped in hooks and extension middleware. */
    tools: ToolSet;
    call: AgentCallConfig;
    providerOptions: AgentCallConfig["providerOptions"];
}

/**
 * The call's provider options plus everything layered per turn: Ollama's
 * context pin, a native agent's turn context, then extension middleware.
 */
export function turnProviderOptions(input: {
    call: AgentCallConfig;
    provider: string;
    modelInfo: ModelInfo | undefined;
    session: Session;
    cwd: string;
    turnContext: TurnContext;
}): AgentCallConfig["providerOptions"] {
    let providerOptions = withOllamaContext(input.call.providerOptions, input.provider, input.modelInfo);
    // Native agents (Claude Code, Cursor) run their own loop: they need to know
    // which loop session they continue (to resume their native session instead
    // of replaying history), where to work, and how to ask for permission.
    // Utility calls never carry this, which is how the provider tells a real
    // turn from a title/recap request.
    if (isNativeAgentProvider(input.provider)) {
        const native: NativeAgentTurnContext = {
            loopSessionId: input.session.id,
            cwd: input.cwd,
            planMode: isPlanModeActive(input.session.id),
            approvals: getSetting("bashApprove") === true && getBashApprovalBridge() !== null,
        };
        providerOptions = { ...providerOptions, [input.provider]: { ...native } };
    }
    return applyProviderOptions(providerOptions, input.turnContext) as typeof providerOptions;
}

/** The parts every request of this turn shares, over `messages`. */
export function requestBase(req: TurnRequest, messages: ModelMessage[]) {
    const { call } = req;
    return {
        model: req.model,
        ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
        ...(call.anthropicCaching
            ? // system inside messages is our deliberate Anthropic prompt-caching
              // pattern — allowSystemInMessages opts out of the AI SDK warning.
              { messages: withAnthropicCaching(req.system, messages), allowSystemInMessages: true as const }
            : { instructions: req.system, messages }),
        tools: req.tools,
        // v7 portable reasoning effort for first-party providers (off → "none").
        // Undefined for community providers / non-reasoning models, which use
        // providerOptions (or nothing) instead.
        ...(call.reasoning ? { reasoning: call.reasoning } : {}),
        ...(req.providerOptions ? { providerOptions: req.providerOptions as never } : {}),
    };
}

export interface StreamHooks {
    toolsForTurn: Record<string, unknown>;
    prepareStep: PrepareStep | undefined;
    midTurn: MidTurnCompaction;
    timing: StepTimingRecorder;
    persistStep: (step: FinishedStep) => void;
    abortSignal?: AbortSignal;
}

/**
 * Open a stream over `messages`, with `remainingSteps` of the turn's step
 * budget left. Called once normally, and again per resume — a resumed stream
 * is a fresh call over the conversation the finished steps left behind, not a
 * replay.
 */
export function openTurnStream(req: TurnRequest, hooks: StreamHooks, messages: ModelMessage[], remainingSteps: number) {
    const { timing } = hooks;
    return streamText({
        ...requestBase(req, messages),
        // Caching tail-move, notices and team mail — undefined when none applies.
        ...(hooks.prepareStep ? { prepareStep: hooks.prepareStep } : {}),
        stopWhen: [
            isStepCount(remainingSteps),
            // A plan-capable turn also stops once a substantial plan is delivered
            // (stub deliveries keep the loop alive — see planDeliveredThisStep).
            ...(PLAN_TOOL_NAME in hooks.toolsForTurn ? [planDeliveredThisStep] : []),
            // A member's report is its last word: the turn ends there.
            ...(REPORT_TOOL in hooks.toolsForTurn ? [reportedThisStep] : []),
            hooks.midTurn.isDue,
        ],
        abortSignal: hooks.abortSignal,
        // Persist each step's messages as it finishes. Errors here must not break the turn.
        onStepEnd: (step) => hooks.persistStep(step as never),
        // Trace anchors. onStepStart is the only start instant we keep
        // ourselves — everything else comes as durations on the step result.
        onStepStart: () => timing.stepStarted(),
        onToolExecutionStart: (event) => {
            const call = (event as { toolCall?: { toolCallId?: string; toolName?: string } }).toolCall;
            if (call?.toolCallId) timing.toolStarted(call.toolCallId, call.toolName ?? "");
        },
        onToolExecutionEnd: (event) => {
            const e = event as { toolCall?: { toolCallId?: string }; toolOutput?: { type?: string } };
            if (e.toolCall?.toolCallId) timing.toolEnded(e.toolCall.toolCallId, e.toolOutput?.type === "tool-error");
        },
        // The SDK's default onError does console.error(error) with the whole
        // APICallError (request body, tool defs — a wall of noise). Stream
        // errors surface cleanly via the stream "error" part, so swallow this
        // duplicate to keep the console clean.
        onError: () => {},
        // No smoothStream: it re-buffers tokens and releases them on its own
        // 20ms timers, coupling stream delivery to the timer phase — the same
        // phase that starves during a turn, which can deadlock delivery and
        // freeze the TUI. Parts stream raw.
    });
}
