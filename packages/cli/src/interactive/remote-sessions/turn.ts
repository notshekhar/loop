/**
 * Drawing a turn that runs somewhere else: on a `/hosts` machine (begin/end
 * from its event stream), or on this machine's own `/rc` server for a session
 * open here (`followServerTurn`). Both render through the same
 * `wireTurnEmitter` a local turn uses and close the same way.
 */
import { EventEmitter } from "node:events";
import { asTurnEmitter } from "@notshekhar/loop-core";
import type { SessionSlot } from "../slots";
import { createSubagentStream } from "../subagent-stream";
import { wireTurnEmitter } from "../turn-emitter";
import { describeTurnFailure } from "../turn-runner";
import { dim } from "../ui/text";
import { providerOf, TURN_EVENTS, type RemoteState, type RemoteTurn } from "./state";

/** The pieces of one drawn turn that live until it closes. */
interface TurnView {
    emitter: ReturnType<typeof asTurnEmitter>;
    subagentStream: ReturnType<typeof createSubagentStream>;
    errors: unknown[];
}

/** An assistant row and an emitter wired to the slot's transcript. */
function openTurnView(state: RemoteState, slot: SessionSlot, modelId: string, foreign: boolean): TurnView {
    const { roster, tui } = state.host;
    const d = roster.depsFor(slot);
    const provider = providerOf(modelId);
    slot.history.ensureAssistant(provider, modelId);
    const emitter = asTurnEmitter(new EventEmitter());
    const subagentStream = createSubagentStream(slot.history, tui);
    const errors: unknown[] = [];
    wireTurnEmitter(emitter, {
        history: slot.history,
        tui,
        state: roster.viewOf(slot),
        turnProvider: provider,
        subagentStream,
        todoPanel: slot.todoPanel,
        showWorking: d.showWorking,
        refreshStatusLine: d.refreshStatusLine,
        onTurnError: (e) => errors.push(e),
        // Nothing here typed what opened this turn; a team card comes from the stream.
        drawsTeamOpening: true,
        // Another device's prompt is shown; one typed here is already on screen.
        drawsForeignPrompt: foreign,
    });
    return { emitter, subagentStream, errors };
}

/** The end of a drawn turn: its summary line, the todo retired, and the next queued message sent. */
function closeTurnView(
    state: RemoteState,
    slot: SessionSlot,
    turn: { startedAt: number; errors: unknown[]; signal: AbortSignal },
): void {
    const { roster, tui } = state.host;
    const d = roster.depsFor(slot);
    slot.history.finishAssistant();
    if (turn.signal.aborted) slot.history.markPendingToolsInterrupted();
    else {
        const seconds = (Date.now() - turn.startedAt) / 1000;
        if (turn.errors.length > 0) slot.history.addTurnFailed(seconds, describeTurnFailure(turn.errors));
        else slot.history.addTurnSummary(seconds);
    }
    if (!slot.todoPanel.isEmpty()) {
        slot.history.addSystem(slot.todoPanel.retireLine());
        slot.todoPanel.clear();
    }
    d.hideWorking();
    d.settleTurn(turn.errors.length > 0 && !turn.signal.aborted);
    tui.requestRender();
    // Typed while it was busy: the next one goes now.
    const next = slot.queue.shift();
    if (next !== undefined) {
        d.renderPending();
        void roster.runnerFor(slot)(next);
    }
}

/** Open (or return) the turn a `/hosts` session is running. */
export function beginTurn(state: RemoteState, slot: SessionSlot): RemoteTurn {
    const current = state.turns.get(slot);
    if (current) return current;
    const link = slot.remote!;
    const d = state.host.roster.depsFor(slot);
    const foreign = !state.sentHere.has(slot);
    if (foreign) slot.history.addSystem(dim(`a turn started on ${link.host.label} from another device`));
    state.sentHere.delete(slot);
    slot.busy = true;
    const { emitter, subagentStream, errors } = openTurnView(state, slot, link.model, foreign);
    // Esc / Ctrl+C here cancels the turn THERE.
    const signal = slot.abort.signal;
    const watched = new Set<AbortSignal>([signal]);
    const onAbort = () => {
        void link.client.call("session.cancel", { sessionId: link.sessionId }).catch(() => {});
        // The input handler marks the chat idle right after aborting, but
        // the host is still winding the turn down, and says so with
        // `session-running false` (endTurn). Until then stay busy: a
        // message typed now queues instead of being sent into the dying
        // turn — whose end would then be written under the new one — and
        // the next Esc still reaches the host. A microtask, so it runs
        // after the handler's own synchronous reset.
        queueMicrotask(() => {
            if (state.turns.get(slot) !== turn) return;
            slot.busy = true;
            d.showWorking("Stopping");
            const next = slot.abort.signal;
            if (!watched.has(next)) {
                watched.add(next);
                next.addEventListener("abort", onAbort, { once: true });
            }
        });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const turn: RemoteTurn = {
        startedAt: Date.now(),
        errors,
        emitter,
        signal,
        dispose: () => {
            for (const s of watched) s.removeEventListener("abort", onAbort);
            subagentStream.dispose();
        },
    };
    state.turns.set(slot, turn);
    d.showWorking("Generating");
    return turn;
}

/** Close the turn a `/hosts` session was running, if one is open. */
export function endTurn(state: RemoteState, slot: SessionSlot): void {
    const turn = state.turns.get(slot);
    slot.busy = false;
    if (!turn) return;
    state.turns.delete(slot);
    turn.dispose();
    closeTurnView(state, slot, turn);
}

/**
 * A turn the `/rc` server is running itself, in a session just opened
 * here — a phone started it before this loop had the session open. It is
 * drawn as it streams, from its first word (the server replays what came
 * before), exactly as a /hosts turn is; the slot is busy meanwhile, so
 * what is typed here (or sent from a phone) waits for it; and Esc stops it
 * on the server.
 */
export function followServerTurn(state: RemoteState, sessionId: string): void {
    const server = state.rc;
    if (!server || !server.live.isRunning(sessionId)) return;
    const { slots, roster, tui } = state.host;
    const slot = slots.bySessionId(sessionId);
    if (!slot || slot.remote || slot.busy) return;
    const d = roster.depsFor(slot);
    slot.busy = true;
    slot.history.addSystem(dim("a turn started from another device"));
    // Started from another device: show what it asked.
    const { emitter, subagentStream, errors } = openTurnView(state, slot, slot.modelId, true);
    const signal = slot.abort.signal;
    const onAbort = () => server.live.cancel(sessionId);
    signal.addEventListener("abort", onAbort, { once: true });
    const startedAt = Date.now();
    let stop: () => void = () => {};
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        stop();
        signal.removeEventListener("abort", onAbort);
        subagentStream.dispose();
        slot.busy = false;
        closeTurnView(state, slot, { startedAt, errors, signal });
    };
    d.showWorking("Generating");
    stop = server.live.watch(
        sessionId,
        (part) => {
            if (part.type === "session-running") {
                if (!(part.data as { running?: boolean }).running) finish();
                return;
            }
            if (!TURN_EVENTS.has(part.type)) return;
            (emitter as unknown as EventEmitter).emit(part.type, part.data);
            tui.requestRender();
        },
        { fromTurnStart: true },
    );
    if (!server.live.isRunning(sessionId)) finish();
}
