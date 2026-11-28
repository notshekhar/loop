import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { RpcParams } from "./codex-rpc";
import { mapCodexItem, mapCodexPlan } from "./tool-map";
import { finishReason, makeUsage, PartWriter, type NativeAgentProviderId } from "./shared";

/** Codex's per-call token counts (`TokenUsageBreakdown`). */
interface TokenCounts {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

type Item = Record<string, unknown> & { id?: unknown; type?: unknown };

/**
 * Turns one Codex turn's app-server notifications into ai-sdk stream parts.
 * `settled` resolves when the turn is over — completed, failed or
 * interrupted — after the closing `finish` part has been sent.
 */
export class CodexTurnReader {
    producedOutput = false;
    /** The thread this turn runs on; notifications for any other (a subagent's) are not ours. */
    threadId: string | undefined;
    readonly settled: Promise<void>;
    private settle!: () => void;
    private finished = false;
    private failure: string | undefined;
    private readonly w: PartWriter;
    private readonly toolNames = new Map<string, string>();
    private readonly streamedMessages = new Set<string>();
    private readonly usage = new TurnUsage();
    private planCalls = 0;

    constructor(
        private readonly enqueue: (part: LanguageModelV4StreamPart) => void,
        private readonly provider: NativeAgentProviderId,
        private readonly modelId: string,
    ) {
        this.w = new PartWriter(enqueue, provider);
        this.settled = new Promise<void>((resolve) => (this.settle = resolve));
    }

    onNotification(method: string, params: RpcParams): void {
        if (this.finished) return;
        if (this.threadId && typeof params.threadId === "string" && params.threadId !== this.threadId) return;
        switch (method) {
            case "item/agentMessage/delta":
                this.streamedMessages.add(String(params.itemId));
                this.producedOutput = true;
                this.w.text(String(params.delta ?? ""));
                break;
            case "item/reasoning/summaryTextDelta":
                this.w.reasoning(String(params.delta ?? ""));
                break;
            case "item/reasoning/summaryPartAdded":
                this.w.reasoning("\n\n");
                break;
            case "item/started":
                this.onItemStarted(params.item as Item);
                break;
            case "item/completed":
                this.onItemCompleted(params.item as Item);
                break;
            case "turn/plan/updated":
                this.onPlan(params.plan);
                break;
            case "thread/tokenUsage/updated":
                this.usage.update(params.tokenUsage as { total: TokenCounts; last: TokenCounts });
                break;
            case "error":
                // A retried error is Codex's own business; only a final one ends the turn.
                if (params.willRetry !== true) this.failure = errorMessage(params.error);
                break;
            case "turn/completed":
                this.onTurnCompleted(params.turn as { status?: string; error?: unknown });
                break;
            default:
                break;
        }
    }

    /** The server went away (or the turn was abandoned) before `turn/completed`. */
    endUnfinished(reason: string | undefined, aborted: boolean): void {
        if (this.finished) return;
        this.w.endAll();
        if (!aborted && reason) this.enqueue({ type: "error", error: new Error(`Codex: ${this.failure ?? reason}`) });
        this.close(aborted ? finishReason("other", "aborted") : finishReason("error"));
    }

    private onItemStarted(item: Item): void {
        const mapped = mapCodexItem(item);
        if (!mapped) return;
        const id = `codex-${String(item.id ?? "")}`;
        this.toolNames.set(id, mapped.name);
        this.producedOutput = true;
        this.w.toolCall(id, mapped.name, mapped.input);
    }

    private onItemCompleted(item: Item): void {
        if (item.type === "agentMessage") {
            // A message that arrived whole (no deltas) is written now.
            if (!this.streamedMessages.has(String(item.id))) this.w.text(String(item.text ?? ""));
            this.w.endText();
            this.producedOutput = true;
            return;
        }
        if (item.type === "reasoning") {
            this.w.endReasoning();
            return;
        }
        const mapped = mapCodexItem(item);
        if (!mapped) return;
        const id = `codex-${String(item.id ?? "")}`;
        if (!this.toolNames.has(id)) this.onItemStarted(item);
        this.w.toolResult(id, mapped.name, mapped.result ?? "", mapped.isError === true);
    }

    private onPlan(plan: unknown): void {
        const id = `codex-plan-${++this.planCalls}`;
        const mapped = mapCodexPlan(plan);
        this.w.toolCall(id, mapped.name, mapped.input);
        this.w.toolResult(id, mapped.name, "", false);
    }

    private onTurnCompleted(turn: { status?: string; error?: unknown }): void {
        this.w.endAll();
        if (turn.status === "interrupted") return this.close(finishReason("other", "aborted"));
        if (turn.status === "failed") {
            this.enqueue({ type: "error", error: new Error(`Codex: ${errorMessage(turn.error) ?? this.failure ?? "the turn failed"}`) });
            return this.close(finishReason("error", "failed"));
        }
        this.close(finishReason("stop"));
    }

    private close(reason: ReturnType<typeof finishReason>): void {
        this.finished = true;
        this.enqueue({
            type: "finish",
            usage: this.usage.toUsage(),
            finishReason: reason,
            providerMetadata: { [this.provider]: { sessionId: this.threadId ?? null, model: this.modelId } },
        });
        this.settle();
    }
}

/**
 * Codex reports usage as running thread totals plus the last API call. Loop
 * wants context occupancy (the last call's input) and the output this TURN
 * produced, so the thread's output before the turn is subtracted out.
 */
class TurnUsage {
    private last: TokenCounts | undefined;
    private outputBefore: number | undefined;
    private reasoningBefore: number | undefined;
    private total: TokenCounts | undefined;

    update(u: { total: TokenCounts; last: TokenCounts } | undefined): void {
        if (!u?.total || !u.last) return;
        // The first update of the turn already includes its first call.
        this.outputBefore ??= u.total.outputTokens - u.last.outputTokens;
        this.reasoningBefore ??= u.total.reasoningOutputTokens - u.last.reasoningOutputTokens;
        this.last = u.last;
        this.total = u.total;
    }

    toUsage() {
        const last = this.last;
        if (!last || !this.total) return makeUsage({});
        const cacheRead = last.cachedInputTokens ?? 0;
        const cacheWrite = last.cacheWriteInputTokens ?? 0;
        return makeUsage({
            // Codex's input_tokens already include the cached share.
            input: Math.max(0, last.inputTokens - cacheRead - cacheWrite),
            cacheRead,
            cacheWrite,
            output: this.total.outputTokens - (this.outputBefore ?? 0),
            reasoning: this.total.reasoningOutputTokens - (this.reasoningBefore ?? 0),
        });
    }
}

function errorMessage(error: unknown): string | undefined {
    const message = (error as { message?: unknown } | null | undefined)?.message;
    if (typeof message !== "string" || !message) return undefined;
    // API errors arrive as the raw JSON body; its inner message is the readable part.
    try {
        const body = JSON.parse(message) as { error?: { message?: unknown } };
        if (typeof body.error?.message === "string") return body.error.message;
    } catch {
        /* plain text */
    }
    return message;
}
