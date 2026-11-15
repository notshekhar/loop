/**
 * Incremental persistence: each completed step's messages are written as it
 * finishes, so tool calls/results AND the final answer survive turn
 * boundaries and aborts.
 *
 * `step.response.messages` holds only THIS step's new messages — the AI SDK
 * resets its per-step content buffer on every `start-step`, so it is NOT
 * cumulative. Persist all of them; there is no overlap across steps to dedupe.
 * (Slicing against a running count, on the mistaken assumption it was
 * cumulative, dropped every step after the first — losing the final answer and
 * its usage on reopen.)
 */
import { attachLedgerEntry, type Session } from "../../sessions";
import type { UsageBlock } from "../../types";
import { debugLog } from "../../debug";
import { stampUsageCost } from "../cost";
import type { StepBilling } from "../model-call";
import { StepTimingRecorder, type SdkStepTimingFields } from "../step-timing";
import { stepMessagesToEntries, type PersistedTurnMessage } from "./step-entries";

export type FinishedStep = SdkStepTimingFields & {
    response: { messages: ReadonlyArray<{ role: string; content: unknown }> };
    usage?: UsageBlock;
};

/** Present only on the entry the step's timing rides (its assistant message). */
type TimingField = { timing?: ReturnType<StepTimingRecorder["stepEnded"]> };

export class StepPersister {
    /** Wall clock per step for the trace view (see step-timing.ts). */
    readonly timing = new StepTimingRecorder();
    persistedAnyMessage = false;
    /** Serializes appends so each step lands in order even if callbacks overlap. */
    private chain: Promise<void> = Promise.resolve();
    /**
     * Wall clock per reasoning part, in stream order — stamped onto the step's
     * assistant entry as reasoningMs so "Thought for Xs" survives resume.
     */
    private readonly reasoningDurations: number[] = [];
    private reasoningStartedAt = 0;

    constructor(
        private readonly session: Session,
        private readonly modelId: string,
        private readonly billing: StepBilling,
    ) {}

    reasoningStarted(): void {
        this.reasoningStartedAt = Date.now();
    }

    reasoningEnded(): void {
        this.reasoningDurations.push(Date.now() - (this.reasoningStartedAt || Date.now()));
    }

    /**
     * Run `write` after everything queued so far. Persistence must never
     * break a turn — but a failed transcript write is data loss, so leave a
     * breadcrumb (LOOP_DEBUG=1).
     */
    enqueue(write: () => Promise<void>, what: string): Promise<void> {
        this.chain = this.chain
            .then(write)
            .catch((err) => debugLog("persist", `${what} failed for session ${this.session.id}:`, err));
        return this.chain;
    }

    /** Every queued write has landed. */
    flush(): Promise<void> {
        return this.chain;
    }

    persistStep(step: FinishedStep): Promise<void> {
        const entries = stepMessagesToEntries(step.response.messages, step.usage);
        if (entries.length > 0) this.persistedAnyMessage = true;
        // Snapshot THIS step's durations and timing now — the queue keeps
        // filling while the append waits its turn. onStepEnd IS the step's end
        // instant; the timing rides the assistant entry, never the tool results.
        const reasoningMs = this.reasoningDurations.splice(0, this.reasoningDurations.length);
        const timingField: TimingField = { timing: this.timing.stepEnded(step) };
        const timingEntry = entries.find((e) => e.role === "assistant");
        return this.enqueue(async () => {
            const rows = entries.map((entry) =>
                this.toRow(entry, reasoningMs, entry === timingEntry ? timingField : {}),
            );
            // One batch = one transaction for the whole step's messages.
            await this.session.appendAll(rows);
            this.attributeLedgerRow(rows);
        }, "step persistence");
    }

    private toRow(entry: PersistedTurnMessage, reasoningQueue: number[], timingField: TimingField) {
        // Display metadata: this entry's reasoning-part durations, in part
        // order (see the Entry type for why not in content).
        const reasoningMs = Array.isArray(entry.content)
            ? reasoningQueue.splice(
                  0,
                  (entry.content as Array<{ type?: string }>).filter((p) => p?.type === "reasoning").length,
              )
            : [];
        return {
            type: "message" as const,
            ts: Date.now(),
            role: entry.role,
            content: entry.content,
            ...(reasoningMs.length > 0 ? { reasoningMs } : {}),
            ...timingField,
            // Stamp the model AND the billed USD on usage-bearing (assistant)
            // entries so cost seeding reads the true historical cost after a
            // model switch or catalog drift.
            ...(entry.usage ? { usage: stampUsageCost(this.modelId, entry.usage), model: this.modelId } : {}),
        };
    }

    /**
     * appendAll assigned ids in place — attribute this step's ledger row to
     * the entry that carries its usage. Persist and billing race per step; an
     * empty queue just skips attribution (the money row itself is safe).
     */
    private attributeLedgerRow(rows: ReadonlyArray<{ id?: string; usage?: unknown }>): void {
        const usageEntry = rows.find((r) => "usage" in r && r.usage);
        if (!usageEntry?.id) return;
        const rowId = this.billing.rowIds.shift();
        if (rowId !== undefined) attachLedgerEntry(rowId, usageEntry.id);
    }
}
