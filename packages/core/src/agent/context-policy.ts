/**
 * The seam an extension uses to decide what happens when a turn crosses the
 * context threshold. Core registers nothing, so an install with no extensions
 * takes the summarizing path it always took.
 *
 * Only one policy is active at a time. Registration keeps the FIRST and warns
 * about the rest: with load order deciding silently, two policies fighting over
 * the same boundary is a bug nobody can see.
 */
import { debugLog } from "../debug";
import type { Session } from "../sessions";
import type { Entry } from "../types";

export type ContextDecision =
    /** Summarize, exactly as core does today. */
    | { kind: "summarize" }
    /** Start a fresh window with this recovery record, no model call. */
    | { kind: "rollover"; handoff: string; cutAt: number }
    /** Policy declines; leave the transcript alone this turn. */
    | { kind: "none" };

export interface ContextDecisionInput {
    session: Session;
    modelId: string;
    cwd: string;
    /** Estimated tokens in context, INCLUDING system prompt and tool schemas. */
    usedTokens: number;
    contextWindow: number;
    overheadTokens: number;
    /** Where the model's own compaction line sits. */
    thresholdTokens: number;
    /**
     * "mid-turn": crossed between two steps of one turn. The branch then ends
     * on tool results no model has read yet, not on the user's new message.
     * "overflow": the provider refused a request as too big for its window.
     */
    reason: "threshold" | "mid-turn" | "overflow" | "explicit";
}

export interface ContextPolicy {
    name: string;
    decide(input: ContextDecisionInput): Promise<ContextDecision> | ContextDecision;
}

let active: ContextPolicy | undefined;

export function registerContextPolicy(policy: ContextPolicy): void {
    if (active && active.name !== policy.name) {
        debugLog(
            "context-policy",
            `"${policy.name}" ignored: "${active.name}" already owns the context boundary. ` +
                "Enable only one context policy extension.",
        );
        return;
    }
    active = policy;
}

export function clearContextPolicy(): void {
    active = undefined;
}

export function getContextPolicy(): ContextPolicy | undefined {
    return active;
}

/** What the threshold branch should do. Always "summarize" with no policy loaded. */
export async function decideContextAction(input: ContextDecisionInput): Promise<ContextDecision> {
    if (!active) return { kind: "summarize" };
    try {
        return await active.decide(input);
    } catch (err) {
        // A broken policy must never cost the user their turn.
        debugLog("context-policy", `"${active.name}" threw; falling back to summarize: ${String(err)}`);
        return { kind: "summarize" };
    }
}

/** The live budget, refreshed once per turn when the estimate is computed. */
export interface ContextBudgetSnapshot {
    used: number;
    window: number;
    rolloverAt: number;
    supported: boolean;
}

let budget: ContextBudgetSnapshot | undefined;

export function setContextBudget(next: ContextBudgetSnapshot | undefined): void {
    budget = next;
}

export function readContextBudget(): ContextBudgetSnapshot | undefined {
    return budget;
}

/**
 * A pending `new_context` request. Deliberately module state rather than a
 * return value: the tool that asks for a boundary runs mid-stream, but the
 * boundary can only be committed once every entry for the turn has landed.
 */
let pendingBoundary: { handoff?: string } | undefined;

export function requestContextBoundary(handoff?: string): void {
    pendingBoundary = { handoff };
}

/** Take and clear the request. Called once at the end of a turn. */
export function takeContextBoundary(): { handoff?: string } | undefined {
    const req = pendingBoundary;
    pendingBoundary = undefined;
    return req;
}

/** Drop a pending request without acting on it — used when a turn aborts. */
export function clearContextBoundary(): void {
    pendingBoundary = undefined;
}

/**
 * The running turn's branch, for tools that must read conversation the model
 * can no longer see (a history tool after a rollover). Set once per turn; a
 * function rather than a snapshot so a tool called late in a turn sees the
 * entries that landed during it.
 */
let branchSource: (() => readonly Entry[]) | undefined;

export function setActiveBranch(fn: (() => readonly Entry[]) | undefined): void {
    branchSource = fn;
}

export function readActiveBranch(): readonly Entry[] {
    return branchSource?.() ?? [];
}
