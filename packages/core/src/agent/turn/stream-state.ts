/**
 * What one turn accumulates from its stream(s): the reply, tools used, usage,
 * the un-persisted tail of the step in flight, and the bookkeeping behind
 * exactly-one `finish`. Deliberately outlives a single stream, so a resumed
 * or compacted stream continues the same turn rather than starting a new one.
 */
import type { TextStreamPart, ToolSet } from "ai";
import type { UsageBlock } from "../../types";
import { toolInputDeltaEvent, toolInputStartEvent, type TurnEmitter } from "../events";
import type { StepBilling } from "../model-call";
import { ProviderExecutedTail } from "../provider-executed-tail";
import type { StepPersister } from "./step-persistence";

type StreamPart = TextStreamPart<ToolSet>;

/** A finish part's usage, held back until the turn knows it is really over. */
interface HeldFinish {
    usage?: UsageBlock;
}

export class TurnStreamState {
    assistantText = "";
    readonly toolsUsed: string[] = [];
    lastUsage: UsageBlock | undefined;
    lastStepUsage: UsageBlock | undefined;
    /**
     * Text/reasoning streamed since the last FINISHED step (reset on each
     * finish-step). On abort this is the un-persisted tail of the interrupted
     * step — the only part not already saved/billed.
     */
    textSinceStep = "";
    reasoningSinceStep = "";
    /** The same tail in stream order, tools included — for providers that run the tools themselves. */
    readonly providerTail = new ProviderExecutedTail();
    /** The AI SDK skips its `finish` part on abort; whether one was forwarded already. */
    sawFinish = false;
    /** Steps completed across every attempt — the resume budget is what remains of maxSteps. */
    stepsDone = 0;
    /**
     * A failure the attempt loop may still recover from. Cleared at the top of
     * each attempt, so it always describes the CURRENT one; a failure we then
     * recovered from is never reported at all.
     */
    streamError: unknown;
    /** A `finish` withheld because the stream ended on a recoverable error. */
    pendingFinish: HeldFinish | undefined;
    /** A `finish` from a stream stopped for mid-turn compaction. */
    compactionFinish: HeldFinish | undefined;

    constructor(
        private readonly emitter: TurnEmitter,
        private readonly billing: StepBilling,
        private readonly persister: StepPersister,
        /** Whether an error can still be recovered from (resume or overflow compaction). */
        private readonly recoverable: (err: unknown) => boolean,
        /** Whether the stream was stopped for a mid-turn compaction. */
        private readonly compactionDue: () => boolean,
    ) {}

    /** Text or reasoning of the interrupted step has streamed. */
    get tailStreamed(): boolean {
        return this.textSinceStep !== "" || this.reasoningSinceStep !== "";
    }

    /** Forward the turn's single `finish`, unless one went out already. */
    finishOnce(usage: UsageBlock | undefined): void {
        if (this.sawFinish) return;
        this.sawFinish = true;
        this.emitter.emit("finish", { usage, lastStepUsage: this.lastStepUsage });
    }

    handlePart(part: StreamPart): void {
        // First output of the step in flight — only the abort path reads this
        // (finished steps get the SDK's own measurement).
        if (part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "tool-input-start") {
            this.persister.timing.outputSeen();
        }
        switch (part.type) {
            case "text-delta":
                return this.onText(part.text);
            case "reasoning-delta":
                return this.onReasoning((part as { text: string }).text);
            case "reasoning-start":
                this.persister.reasoningStarted();
                this.emitter.emit("reasoning-start");
                return;
            case "reasoning-end":
                this.persister.reasoningEnded();
                this.emitter.emit("reasoning-end");
                return;
            case "tool-input-start":
                // Surface the pending tool box as soon as the call begins, before
                // its (possibly large) input has finished streaming. v7 renamed
                // toolCallId → id on these parts; toolInputStartEvent maps it.
                this.emitter.emit("tool-input-start", toolInputStartEvent(part as { id?: string; toolName?: string }));
                return;
            case "tool-input-delta":
                this.emitter.emit("tool-input-delta", toolInputDeltaEvent(part as { id?: string; delta?: string }));
                return;
            case "tool-call":
                if (part.toolName) this.toolsUsed.push(part.toolName);
                this.providerTail.toolCall(part);
                this.emitter.emit("tool-call", part);
                return;
            case "tool-result":
                this.providerTail.toolResult(part);
                this.emitter.emit("tool-result", part);
                return;
            case "tool-error":
                return this.onToolError(part);
            case "finish-step":
                return this.onStepFinished(part);
            case "finish":
                return this.onFinish(part);
            case "error":
                return this.onError((part as { error?: unknown }).error);
        }
    }

    /** A transport failure thrown out of the iteration — same decision as an error part. */
    noteThrown(err: unknown): boolean {
        if (!this.recoverable(err)) return false;
        this.streamError = err;
        return true;
    }

    private onText(text: string): void {
        this.assistantText += text;
        this.textSinceStep += text;
        this.providerTail.text(text);
        this.emitter.emit("text-delta", text);
    }

    private onReasoning(text: string): void {
        this.reasoningSinceStep += text;
        this.providerTail.reasoning(text);
        this.emitter.emit("reasoning-delta", text);
    }

    /**
     * A tool's execute threw (MCP transport failure, timeout, bad args…). The
     * AI SDK still feeds the error back to the model as the tool result, so
     * the loop continues — this just shows it (red) instead of leaving the
     * tool box spinning forever.
     */
    private onToolError(part: StreamPart): void {
        const e = part as { toolCallId?: string; toolName?: string; error?: unknown };
        this.providerTail.toolError(part as never);
        this.emitter.emit("tool-error", { toolCallId: e.toolCallId, toolName: e.toolName, error: e.error });
    }

    private onStepFinished(part: StreamPart): void {
        // The SDK closes a failed stream with a finish-step of its own. That is
        // not a step the model completed: it must not spend the step budget,
        // and it must not clear the un-persisted tail, which is how the resume
        // decision knows whether text was mid-flight.
        if ((part as { finishReason?: string }).finishReason === "error") return;
        // Cost accrues per step, not at turn end — the footer updates live,
        // and an aborted turn keeps the cost of the steps that already ran.
        const usage = (part as { usage?: UsageBlock }).usage;
        if (usage) {
            this.lastStepUsage = usage;
            const { breakdown } = this.billing.onStepUsage(usage);
            this.emitter.emit("step-usage", { usage, breakdown });
        }
        // This step is persisted (onStepEnd) and billed (above): reset the tail
        // so it tracks only the NEXT, possibly aborted, step.
        this.textSinceStep = "";
        this.reasoningSinceStep = "";
        this.providerTail.reset();
        this.stepsDone++;
    }

    private onFinish(part: StreamPart): void {
        const usage = (part as { totalUsage?: UsageBlock }).totalUsage;
        this.lastUsage = usage;
        // The SDK ends a failed stream with a finish too. `finish` is terminal
        // for RPC/web clients, so hold it while the turn may still reopen.
        if ((part as { finishReason?: string }).finishReason === "error" && this.streamError !== undefined) {
            this.pendingFinish = { usage };
            return;
        }
        if (this.compactionDue()) {
            this.compactionFinish = { usage };
            return;
        }
        this.sawFinish = true;
        this.emitter.emit("finish", { usage, lastStepUsage: this.lastStepUsage });
    }

    /**
     * Hold back a failure the attempt loop can recover from — a transient one
     * (resume) or a request too big for the window (compact and retry): if
     * recovery works the user never needed to see it. Anything else is
     * reported immediately.
     */
    private onError(error: unknown): void {
        if (/^(reasoning|text) part .* not found$/.test(String(error ?? ""))) return;
        if (this.recoverable(error)) this.streamError = error;
        else this.emitter.emit("error", error);
    }
}
