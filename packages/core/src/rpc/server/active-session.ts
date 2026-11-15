import { EventEmitter } from "node:events";
import type { Session } from "../../sessions";
import { CostTracker } from "../../agent";
import { emptyTranscript, fromEntries, type Transcript, type TranscriptTodo } from "../../transcript";
import { latestTodos } from "../../tools/todo";
import type { TeamTurnMeta } from "../../teams";
import type { RpcNotification, RpcResponse } from "../protocol";

/** One connected client: a socket, a WebSocket, stdio, or an in-process watcher. */
export type Transport = {
    send(msg: RpcResponse | RpcNotification): void;
};

/** One event of a session's stream, as kept for replay. */
export interface StreamPart {
    type: string;
    data: unknown;
}

export interface RingEntry {
    seq: number;
    part: StreamPart;
}

export interface ActiveSession {
    session: Session;
    tracker: CostTracker;
    abort: AbortController;
    emitter: EventEmitter;
    modelId: string;
    /** True while a turn (or compact) is running — concurrent sends on the
     * same session would interleave appends and corrupt the branch. */
    running: boolean;
    /** Transports receiving this session's events. Events broadcast to all;
     * input (send/cancel) is accepted from any of them. */
    subscribers: Set<Transport>;
    /** Monotonic per-session event counter; stamped on every session.event. */
    seq: number;
    /** Last EVENT_RING_SIZE events, for session.attach {afterSeq} replay. */
    ring: RingEntry[];
    /**
     * `seq` when entries were last written to the session. While a turn runs,
     * the step being streamed is in the ring but not yet in the saved branch,
     * so `session.history` is good only up to here.
     */
    savedSeq?: number;
    /**
     * The conversation as clients draw it (packages/core/src/transcript),
     * kept current by every event this session broadcasts. Clients take it
     * from `session.messages` with the seq it is good to, then apply only
     * later events — none of them rebuilds a turn from history on its own.
     */
    transcript: Transcript;
    /** Team turns handed over while one was running — run next (teams/). */
    pendingTeam?: Array<{ input: string; team: TeamTurnMeta }>;
}

/** A fresh, idle context for `session`; the fields that differ per caller are options. */
export function createActiveSession(
    session: Session,
    opts: { modelId: string; tracker?: CostTracker; subscribers?: Iterable<Transport>; transcript?: Transcript },
): ActiveSession {
    return {
        session,
        tracker: opts.tracker ?? new CostTracker(),
        abort: new AbortController(),
        emitter: new EventEmitter(),
        modelId: opts.modelId,
        running: false,
        subscribers: new Set(opts.subscribers),
        seq: 0,
        ring: [],
        transcript: opts.transcript ?? emptyTranscript(),
    };
}

/** Keep `savedSeq` current: what session.history is good to mid-turn. */
export function trackSaved(ctx: ActiveSession): void {
    ctx.session.onAppend = () => {
        ctx.savedSeq = ctx.seq;
    };
}

/** A session's saved branch as loop's transcript, its checklist with it. */
export function transcriptOf(session: Session, running: boolean): Transcript {
    const branch = session.getBranch();
    return fromEntries(branch, { running, todos: (latestTodos(branch) ?? []) as TranscriptTodo[] });
}

/** Stop whatever this context is running and arm a fresh signal for the next turn. */
export function abortTurn(ctx: ActiveSession): void {
    ctx.abort.abort();
    ctx.abort = new AbortController();
}

/**
 * Refuse while a turn runs here. `wording` keeps each method's long-standing
 * message: the turn-starting methods say "already has".
 */
export function requireIdle(id: string, ctx: ActiveSession | undefined, wording: "has" | "already has" = "has"): void {
    if (ctx?.running) throw new Error(`session ${id} ${wording} a turn running (cancel it first)`);
}
