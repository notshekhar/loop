import type { ActiveSession } from "./active-session";
import { replayAfter } from "./event-stream";
import { providerOfModel, type HandlerTable, type RpcHost } from "./rpc-host";

type ViewHost = Pick<RpcHost, "contexts">;

/** Reading a session and following its stream: what a client renders from. */
export function sessionViewHandlers(host: ViewHost): HandlerTable {
    return {
        "session.history": async (params) => {
            const id = String(params.sessionId);
            return sessionHistory(id, await host.contexts.ensureCtx(id), params);
        },
        "session.messages": async (params) => {
            // The conversation as loop's transcript (packages/core/src/
            // transcript): one assistant message per turn, its parts in
            // the order they were written — the reply so far included
            // while a turn runs. `seq` is the event it is good to: apply
            // session.event with a higher seq, nothing at or below it.
            const id = String(params.sessionId);
            const ctx = await host.contexts.ensureCtx(id);
            return {
                ...sessionHeader(id, ctx),
                messages: ctx.transcript.messages,
                todos: ctx.transcript.todos,
                running: ctx.running,
                seq: ctx.seq,
            };
        },
        "session.open": async (params) => {
            // Reuses a live context: a second client opening the session
            // must NOT reset the running flag / abort controller of a turn
            // in flight. Does NOT subscribe — clients call session.attach
            // after rendering history, so no event can slip in between and
            // apply twice (or out of order).
            const id = String(params.sessionId);
            const ctx = await host.contexts.ensureCtx(id);
            return { sessionId: id, info: ctx.session.info, running: ctx.running, seq: ctx.seq };
        },
        "session.attach": async (params, transport) => {
            // Subscribe + catch up: replays ring events after `afterSeq`,
            // or signals resync when the gap left the ring (client falls
            // back to a full session.history render).
            const id = String(params.sessionId);
            const ctx = await host.contexts.ensureCtx(id);
            ctx.subscribers.add(transport);
            const afterSeq = params.afterSeq === undefined ? undefined : Number(params.afterSeq);
            const { resync } = replayAfter(id, ctx, afterSeq, transport);
            return { ok: true, seq: ctx.seq, running: ctx.running, resync };
        },
        "session.detach": (params, transport) => {
            const id = String(params.sessionId);
            host.contexts.get(id)?.subscribers.delete(transport);
            return { ok: true };
        },
    };
}

/**
 * Who a session is and what it runs on. `info` is the session as CREATED, so
 * info.model/provider are whatever it started on. A GUI that pre-selects from
 * those silently undoes every /model switch, so the model actually in force is
 * reported alongside them.
 */
function sessionHeader(id: string, ctx: ActiveSession) {
    const model = ctx.session.lastModel();
    return {
        sessionId: id,
        info: ctx.session.info,
        model,
        provider: providerOfModel(model) ?? ctx.session.info.provider,
        name: ctx.session.getName(),
    };
}

/**
 * Full transcript along the current branch so a (re)connecting client can
 * render the conversation before subscribing to the live stream. Abandoned
 * branches are excluded — this is what the model sees. Returns the current
 * event seq so the client can session.attach {afterSeq} without a gap.
 */
function sessionHistory(id: string, ctx: ActiveSession, params: Record<string, unknown>) {
    // `afterEntryId`: the client already holds the branch up to
    // that entry — send only what follows it. A long session is
    // hundreds of KB (every tool's output), and a client refreshed
    // it in full at every tool step; over Wi-Fi to a phone that
    // backed updates up until the turn ended. An id no longer on
    // the branch (a fork, a branch switch) gets the whole branch,
    // and `tail` says which answer this is. An older client never
    // sends it and gets the whole branch, as before.
    const branch = ctx.session.getBranch();
    const after = typeof params.afterEntryId === "string" ? params.afterEntryId : null;
    const at = after === null ? -1 : branch.findIndex((e) => e.id === after);
    return {
        ...sessionHeader(id, ctx),
        leafId: ctx.session.getLeafId(),
        entries: at >= 0 ? branch.slice(at + 1) : branch,
        ...(at >= 0 ? { tail: { afterEntryId: after } } : {}),
        // Mid-turn, the saved branch stops at the last written
        // step; the one streaming now is only in the ring. Saying
        // the branch is good to the newest event made a client that
        // opened the session mid-turn skip that step's start — the
        // reply began mid-sentence. `session.attach` from here
        // replays it.
        seq: ctx.running && ctx.savedSeq !== undefined ? ctx.savedSeq : ctx.seq,
        running: ctx.running,
    };
}
