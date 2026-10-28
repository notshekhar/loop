/**
 * The model-call machinery shared by the two agent loops (runTurn and
 * runSubagent): request-shaping (reasoning params, Anthropic prompt-caching,
 * output caps), per-step cost/ledger accrual, and the stream yield gate.
 * Extracted so a billing or freeze-avoidance fix can never again land in one
 * loop and not the other.
 */
import type { ModelMessage } from "ai";
import { effectiveSdkProvider } from "../auth";
import type { ModelInfo, UsageBlock } from "../types";
import { CostTracker, sumUsage, type AddContext } from "./cost";
import { moveAnthropicCacheTail } from "./model-messages";
import { buildReasoningParams, type ThinkingLevel } from "./thinking";

/** Provider-shaping outputs both loops spread into their stream call. */
export interface AgentCallConfig {
    /** The sdk the request is really shaped for (custom gateways map through). */
    effectiveProvider: string;
    /** Anthropic-shaped: system-in-messages caching + moving tail breakpoint. */
    anthropicCaching: boolean;
    /** v7 portable reasoning effort (first-party providers), if any. */
    reasoning?: ReturnType<typeof buildReasoningParams>["reasoning"];
    /** providerOptions-based reasoning (community/edge providers), if any. */
    providerOptions?: Record<string, Record<string, unknown>>;
    /**
     * Cap output at the model's real max — the AI SDK defaults unrecognized
     * Anthropic ids (newer or gateway-named models) to 4096, truncating replies.
     */
    maxOutputTokens?: number;
    /**
     * Per-step moving cache breakpoint: without it, every step after the first
     * re-bills all accumulated tool results at full input price (quadratic in
     * steps on long turns).
     */
    prepareStep?: (opts: { messages: ModelMessage[] }) => { messages: ModelMessage[] };
}

/**
 * Map a model + thinking level to the provider-shaping params of one agent
 * stream call. Pure — session-specific tweaks (ollama num_ctx, extension
 * middleware) layer on top at the call site that needs them.
 */
export function buildAgentCallConfig(opts: {
    provider: string;
    modelShortId: string;
    thinkingLevel: ThinkingLevel;
    modelInfo?: ModelInfo;
}): AgentCallConfig {
    const effectiveProvider = effectiveSdkProvider(opts.provider);
    const anthropicCaching = effectiveProvider === "anthropic";
    // First-party providers translate the level via the portable `reasoning`
    // param; community providers (and Anthropic adaptive-thinking models) fall
    // back to providerOptions — see buildReasoningParams for the full rationale.
    const { reasoning, providerOptions } = buildReasoningParams(
        effectiveProvider,
        opts.modelShortId,
        opts.thinkingLevel,
        opts.modelInfo?.reasoning !== false,
        opts.modelInfo?.reasoning === true,
    );
    return {
        effectiveProvider,
        anthropicCaching,
        ...(reasoning ? { reasoning } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        ...(anthropicCaching && opts.modelInfo?.maxOutput ? { maxOutputTokens: opts.modelInfo.maxOutput } : {}),
        ...(anthropicCaching
            ? {
                  prepareStep: ({ messages }: { messages: ModelMessage[] }) => ({
                      messages: moveAnthropicCacheTail(messages),
                  }),
              }
            : {}),
    };
}

/**
 * Ollama defaults num_ctx to ~4096 regardless of the model's real context,
 * which truncates long agent loops (and summarizer prompts) and makes the
 * model stop early. Pin it to the model's actual context window so history
 * isn't silently dropped.
 */
export function withOllamaContext(
    providerOptions: AgentCallConfig["providerOptions"],
    provider: string,
    modelInfo: ModelInfo | undefined,
): AgentCallConfig["providerOptions"] {
    if (provider !== "ollama") return providerOptions;
    const numCtx = modelInfo?.contextWindow ?? 8192;
    const existing = (providerOptions?.ollama as Record<string, unknown> | undefined) ?? {};
    const existingOpts = (existing.options as Record<string, unknown> | undefined) ?? {};
    return { ...providerOptions, ollama: { ...existing, options: { ...existingOpts, num_ctx: numCtx } } };
}

/** Per-step accrual state for one agent stream (turn or subagent run). */
export interface StepBilling {
    /**
     * Bill one finish-step usage: accrue the running sum, add to the tracker
     * (money first), and queue the ledger row id for the caller's attribution
     * scheme (per-entry for turns, single-entry for subagent runs).
     */
    onStepUsage(usage: UsageBlock): { breakdown: ReturnType<CostTracker["add"]> };
    /**
     * Running sum of finished steps — an aborted stream never sees `finish`,
     * but its completed steps were billed; persisting the sum keeps
     * resumed-session cost seeding honest.
     */
    readonly sum: UsageBlock | undefined;
    /** Ledger rows billed so far, in step order, awaiting entry attribution. */
    readonly rowIds: number[];
}

/**
 * The finish-step billing sequence both loops share. Ordering is a contract:
 * the tracker row (the money) is written before the row id is exposed for
 * attribution, so a persistence race can only skip attribution, never the
 * charge itself.
 */
export function createStepBilling(tracker: CostTracker, modelId: string, meta: AddContext): StepBilling {
    let sum: UsageBlock | undefined;
    const rowIds: number[] = [];
    return {
        onStepUsage(usage: UsageBlock) {
            sum = sumUsage(sum, usage);
            const breakdown = tracker.add(modelId, usage, meta);
            const rowId = tracker.takeLastLedgerRowId();
            if (rowId !== undefined) rowIds.push(rowId);
            return { breakdown };
        },
        get sum() {
            return sum;
        },
        rowIds,
    };
}

// How long the stream loop may run without yielding before it must let the
// render timers fire. ~1 frame at 60fps — bounds freeze to one frame.
export const STREAM_YIELD_INTERVAL_MS = 16;

/**
 * Hand control back to the event loop's macrotask phases.
 *
 * `result.stream` parts arrive buffered, so each read resolves as a
 * microtask. Consuming them in a tight `for await` — each part firing
 * `emitter.emit(...)` → `tui.requestRender()` (which uses `process.nextTick`) —
 * keeps the microtask/nextTick queues perpetually non-empty. Those queues drain
 * *before* the timers phase, so the TUI's `setTimeout` render flush and the
 * spinner's `setInterval` never get to run: the screen freezes mid-turn even
 * though the agent keeps working, and only unsticks when real I/O (a keypress)
 * forces the loop past the timers phase. Awaiting a `setImmediate` makes the
 * loop complete a full iteration — running timers on the way to the check phase —
 * so renders flush. Cheap (~microseconds); we call it time-gated, not per part.
 */
export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Time-gated yield for a stream-consume loop: call after every part; it lets
 * the TUI's render timers fire at most every `intervalMs` without paying the
 * macrotask round-trip per part.
 */
export function createYieldGate(intervalMs: number = STREAM_YIELD_INTERVAL_MS): () => Promise<void> {
    let lastYieldAt = Date.now();
    return async () => {
        if (Date.now() - lastYieldAt >= intervalMs) {
            await yieldToEventLoop();
            lastYieldAt = Date.now();
        }
    };
}
