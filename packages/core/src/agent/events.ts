/**
 * Typed event map for the turn emitter. Every event the agent loop emits is
 * declared here — a typo'd event name or wrong payload shape fails the build
 * instead of silently doing nothing at runtime.
 */
import type { EventEmitter } from "node:events";
import type { CostBreakdown, UsageBlock } from "../types";
import type { TodoItem } from "../tools/todo";
import type { TeamTurnMeta } from "../teams/runtime";

export interface TurnEvents {
    /** The prompt that opens the turn, once it is saved — its entry id is the
     * turn's id in the transcript (packages/core/src/transcript). */
    "user-message": { id: string; text: string; ts: number; team?: TeamTurnMeta };
    /** Team mail handed to the model between two steps of a running turn
     * (teams/). Saved as its own entry, so it is drawn where it arrived. */
    "team-message": { id: string; team: TeamTurnMeta; ts: number };
    "text-delta": string;
    "reasoning-start": void;
    "reasoning-delta": string;
    "reasoning-end": void;
    /** A tool call has begun streaming its input — fires before `tool-call`
     * (which only arrives once the whole input is parsed). Lets the UI show the
     * tool box as pending immediately, so a tool with a large input (e.g. write's
     * file content) doesn't appear to pop in late. */
    "tool-input-start": { toolName?: string; toolCallId?: string };
    /** A raw fragment of the streaming tool-call input (JSON text). Follows
     * `tool-input-start`; lets the UI render a large input (e.g. write's file
     * content) live instead of waiting for the complete `tool-call`. */
    "tool-input-delta": { toolCallId?: string; delta: string };
    "tool-call": { toolName?: string; input?: unknown; toolCallId?: string };
    "tool-result": { toolCallId?: string; output?: unknown };
    /** A tool's execute threw (or timed out). The error rides back to the model
     * as the tool result, so the agent can recover; the UI renders it red. */
    "tool-error": { toolCallId?: string; toolName?: string; error: unknown };
    "tool-input-updated": { toolCallId?: string; toolName: string; input: unknown };
    "attached-images": string[];
    "hook-message": string;
    "hook-terminal-sequence": string;
    // mode: "rollover" starts a fresh window with no summary and no model
    // call, so its end event carries a handoff and never a usage/cost.
    "compact-start": { reason: string; mode?: "summary" | "rollover" };
    "compact-end": {
        summary: string;
        cutAt: number;
        tokensBefore: number;
        tokensAfter?: number;
        aborted?: boolean;
        /** The summary failed; the turn carries on uncompacted. */
        error?: string;
        handoff?: string;
        mode?: "summary" | "rollover";
    };
    "step-usage": { usage: UsageBlock; breakdown: CostBreakdown };
    /**
     * The stream died on a transient provider failure and the turn is
     * reopening it. Only ever fires between steps (the finished ones are
     * persisted), so nothing already shown gets repeated — see the resume
     * block in turn.ts. A turn that recovers emits no `error` at all, which is
     * why this exists: otherwise a retry would be invisible.
     */
    "stream-retry": { attempt: number; max: number; reason: string; stepsDone: number };
    /** Post-turn one-line recap (AI SDK data-* part convention). Arrives after finish. */
    "data-recap": { text: string };
    /** The todo tool replaced the checklist — the complete current list. */
    "todo-update": { items: TodoItem[] };
    finish: { usage?: UsageBlock; lastStepUsage?: UsageBlock };
    error: unknown;
    "subagent-delta": { toolCallId: string; agent: string; text: string };
    "subagent-tool": { toolCallId: string; agent: string; toolName?: string; input?: unknown };
    "subagent-step-usage": {
        toolCallId: string;
        agent: string;
        usage: UsageBlock;
        /** Completed steps so far and their billed USD sum — drives the live
         * `step N · $x` ticker in the task box. */
        steps?: number;
        usd?: number;
    };
    "subagent-finish": { toolCallId: string; agent: string; usage?: UsageBlock };
}

/**
 * Runtime list of every turn event, the single source of truth for consumers
 * that must subscribe to all of them (e.g. the RPC server forwarding the whole
 * stream to a client). `satisfies` rejects a typo'd/renamed name; the
 * `_exhaustive` check below rejects a *missing* one — so adding an event to
 * `TurnEvents` fails the build until it's listed here.
 */
export const TURN_EVENT_NAMES = [
    "user-message",
    "team-message",
    "text-delta",
    "reasoning-start",
    "reasoning-delta",
    "reasoning-end",
    "tool-input-start",
    "tool-input-delta",
    "tool-call",
    "tool-result",
    "tool-error",
    "tool-input-updated",
    "attached-images",
    "hook-message",
    "hook-terminal-sequence",
    "compact-start",
    "compact-end",
    "step-usage",
    "stream-retry",
    "data-recap",
    "todo-update",
    "finish",
    "error",
    "subagent-delta",
    "subagent-tool",
    "subagent-step-usage",
    "subagent-finish",
] as const satisfies readonly (keyof TurnEvents)[];

// Fails to compile if a TurnEvents key is missing from TURN_EVENT_NAMES.
type _MissingEvent = Exclude<keyof TurnEvents, (typeof TURN_EVENT_NAMES)[number]>;
const _exhaustive: [_MissingEvent] extends [never] ? true : ["missing from TURN_EVENT_NAMES", _MissingEvent] = true;
void _exhaustive;

/**
 * Map the SDK's tool-input stream parts to our event payloads. AI SDK v7
 * renamed these parts' fields (toolCallId → id, inputTextDelta → delta); the
 * old names kept being read through casts, so every tool-input-start event
 * carried toolCallId: undefined and the UI never showed the pending tool box
 * until the whole input had streamed (the write/edit live-preview regression).
 * Read both shapes so either SDK naming works. Pure + exported for tests.
 */
export function toolInputStartEvent(part: {
    id?: string;
    toolCallId?: string;
    toolName?: string;
}): TurnEvents["tool-input-start"] {
    return { toolName: part.toolName, toolCallId: part.id ?? part.toolCallId };
}

export function toolInputDeltaEvent(part: {
    id?: string;
    toolCallId?: string;
    delta?: string;
    inputTextDelta?: string;
}): TurnEvents["tool-input-delta"] {
    return { toolCallId: part.id ?? part.toolCallId, delta: part.delta ?? part.inputTextDelta ?? "" };
}

type Args<K extends keyof TurnEvents> = TurnEvents[K] extends void ? [] : [TurnEvents[K]];

/** Structurally satisfied by node's EventEmitter — `new EventEmitter()` works. */
export interface TurnEmitter {
    emit<K extends keyof TurnEvents>(event: K, ...args: Args<K>): boolean;
    on<K extends keyof TurnEvents>(event: K, listener: (...args: Args<K>) => void): this;
}

/** Convenience: a plain EventEmitter viewed through the typed surface. */
export function asTurnEmitter(emitter: EventEmitter): TurnEmitter {
    return emitter as unknown as TurnEmitter;
}
