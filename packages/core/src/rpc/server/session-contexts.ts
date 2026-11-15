import { SessionManager, type Session } from "../../sessions";
import { CostTracker } from "../../agent";
import { createActiveSession, trackSaved, transcriptOf, type ActiveSession, type Transport } from "./active-session";
import { broadcast, wireCtx } from "./event-stream";
import type { Announce } from "./clients";

/**
 * A session whose turns run OUTSIDE this server — in the TUI that started
 * `/rc`. The server does not run them: a client's send is handed to the TUI
 * (which shows it and runs it exactly as if it had been typed there), and the
 * TUI feeds the turn's events back in (`publishLive` / `setLiveRunning`), so
 * every client and the TUI's own screen render the one stream.
 */
export interface LiveSession {
    /** The session object the TUI is appending to — history is read from it. */
    readonly session: Session;
    /** Run this as a chat turn there; queued there if a turn is running. */
    send(input: string): void;
    cancel(): void;
}

export interface LiveSessionProvider {
    /** The TUI's live session for this id, if it has one open. */
    get(sessionId: string): LiveSession | undefined;
}

/**
 * The sessions this server holds open, each with its event stream and turn
 * state, and the one place that loads them from the store.
 */
export class SessionContexts {
    private sessions = new Map<string, ActiveSession>();
    /**
     * Sessions being loaded, so two callers that touch one at once (a team
     * delivery and a client's subscribe) share one context instead of each
     * building its own — two would each run turns against their own copy.
     */
    private opening = new Map<string, Promise<ActiveSession>>();

    constructor(
        readonly manager: SessionManager,
        /** Sessions a host process runs itself (the TUI under `/rc`). */
        readonly live: LiveSessionProvider | null,
        private readonly announce: Announce,
    ) {}

    get(id: string): ActiveSession | undefined {
        return this.sessions.get(id);
    }

    requireSession(id: string): ActiveSession {
        const ctx = this.sessions.get(id);
        if (!ctx) throw new Error(`Unknown sessionId: ${id}`);
        return ctx;
    }

    /** Hold a context made by its caller (session.create), streaming from now on. */
    add(id: string, ctx: ActiveSession): void {
        wireCtx(id, ctx);
        this.sessions.set(id, ctx);
    }

    /** Drop a session's live context: its turn aborted, its subscribers let go. */
    drop(id: string): void {
        const ctx = this.sessions.get(id);
        if (!ctx) return;
        ctx.abort.abort();
        ctx.subscribers.clear();
        this.sessions.delete(id);
    }

    /** Every context, dropped — the server is going away. */
    dropAll(): void {
        for (const id of [...this.sessions.keys()]) this.drop(id);
    }

    /** Transport gone (socket/WS closed): stop broadcasting to it everywhere. */
    unsubscribeEverywhere(transport: Transport): void {
        for (const ctx of this.sessions.values()) ctx.subscribers.delete(transport);
    }

    /**
     * Move the turn-running flag AND tell everyone watching.
     *
     * `ctx.running` is the only authority on whether this server is executing a
     * turn — it is set here and cleared in a `finally`, so unlike the `finish`
     * event it cannot be skipped by a throw, an abort or a dropped socket. It
     * was, however, only ever readable by ASKING (`session.list`,
     * `session.attach`, `session.history`): the flag flipped in silence.
     *
     * That silence is what left clients guessing. A UI cannot poll a boolean it
     * needs to render at 60fps, so the desktop reconstructed it from `finish`
     * instead and layered a quiet-for-six-seconds watchdog underneath to catch
     * the times that never arrived — two derived guesses standing in for a fact
     * the server had all along. Announcing the transition costs one event per
     * turn and makes "is it still working" something a client is TOLD.
     *
     * Idempotent by design: callers may re-assert the state they are already in
     * (an abort racing a natural finish does exactly that) and only real
     * transitions reach the wire.
     */
    setRunning(sessionId: string, ctx: ActiveSession, running: boolean): void {
        if (ctx.running === running) return;
        ctx.running = running;
        broadcast(sessionId, ctx, { type: "session-running", data: { running } });
        // No rebuild from the saved branch here, tempting as it is as a
        // safety net: some of what a turn showed is never saved — the error
        // that ended it — and rebuilding at the end made it vanish the moment
        // a client refetched. The stream-built transcript is the authority
        // for as long as this context lives.
        this.announce({ sessionId, change: "running", running });
    }

    /**
     * The context for a live session, made on first use from the TUI's own
     * Session object, and re-pointed at it if the server had already opened
     * the same session from the store (that copy would not see the TUI's
     * appends).
     */
    liveCtx(sessionId: string): ActiveSession | undefined {
        const live = this.live?.get(sessionId);
        if (!live) return this.sessions.get(sessionId);
        const existing = this.sessions.get(sessionId);
        if (existing) {
            // Only when it is a different object, and never mid-turn. This is
            // reached for every event of the TUI's turns: rebuilding each time
            // threw away the reply streamed so far, so a client opening the
            // session mid-turn got a broken snapshot. And a turn this server is
            // running writes to the object it started with — swapping in the
            // TUI's copy then dropped that reply from the saved branch.
            if (existing.session !== live.session && !existing.running) {
                existing.session = live.session;
                existing.transcript = transcriptOf(live.session, false);
                trackSaved(existing);
            }
            return existing;
        }
        const ctx = createActiveSession(live.session, {
            modelId: live.session.lastModel(),
            transcript: transcriptOf(live.session, false),
        });
        trackSaved(ctx);
        this.sessions.set(sessionId, ctx);
        return ctx;
    }

    /** Live context for a session, loading it from the store on first touch.
     * Reuse is the point: a reload/second client must see the same running
     * flag, abort controller, and event ring as the turn already in flight. */
    async ensureCtx(id: string): Promise<ActiveSession> {
        // A session the TUI has open is read from the TUI's own object.
        if (this.live?.get(id)) return this.liveCtx(id)!;
        const existing = this.sessions.get(id);
        if (existing) {
            await this.refreshIfBehind(id, existing);
            return existing;
        }
        const pending = this.opening.get(id);
        if (pending) return pending;
        const opened = this.openCtx(id).finally(() => this.opening.delete(id));
        this.opening.set(id, opened);
        return opened;
    }

    /**
     * Reload a cached session that another process wrote to since it was
     * loaded — the terminal ran turns in a chat this window has open (one
     * database, two processes). Without this the cached copy was served for as
     * long as the app lived: reopening the chat showed none of them, and only
     * restarting the app did. Never mid-turn: a turn running here writes to
     * the object it started with.
     */
    private async refreshIfBehind(id: string, ctx: ActiveSession): Promise<void> {
        if (ctx.running || !ctx.session.isBehindDisk()) return;
        const fresh = await this.manager.open(id);
        if (ctx.running) return;
        ctx.session = fresh;
        ctx.modelId = fresh.lastModel();
        ctx.transcript = transcriptOf(fresh, false);
        trackSaved(ctx);
        // Watchers re-read it (the web transcript store resnapshots on this).
        this.announce({ sessionId: id, change: "updated" });
    }

    /** Load a session from the store into a fresh live context (ensureCtx's slow path). */
    private async openCtx(id: string): Promise<ActiveSession> {
        const session = await this.manager.open(id);
        const ctx = createActiveSession(session, {
            tracker: seededTracker(session),
            // The model it last RAN on, not the one it was created with — a
            // `session.send` that omits `model` should continue the session,
            // not silently revert it to whatever it started on.
            modelId: session.lastModel(),
            transcript: transcriptOf(session, false),
        });
        this.add(id, ctx);
        return ctx;
    }
}

/**
 * Seeded, not empty. `cost.session` reads this tracker, so an unseeded one
 * reports $0 for a conversation that has cost real money — the client cannot
 * tell "free" from "reopened". This is what the TUI does on resume
 * (`seedFromSession`), and it reads the ledger, so the total is what was
 * actually billed rather than a recompute.
 */
function seededTracker(session: Session): CostTracker {
    const tracker = new CostTracker();
    try {
        tracker.seedFromSession(session);
    } catch {
        // A tracker that cannot be seeded still bills this process's turns
        // correctly; refusing to open the session would be worse.
    }
    return tracker;
}
