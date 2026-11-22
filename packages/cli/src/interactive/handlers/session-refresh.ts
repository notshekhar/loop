/**
 * /refresh — reload the live session from the database.
 *
 * Every loop shares one agent.db, so a second terminal can resume this same
 * session and add turns to it. This process keeps the Session object it
 * loaded and never looks again, so those turns stay invisible here — and the
 * next message sent from here would hang off the stale leaf, quietly forking
 * the chat. /refresh swaps in a fresh copy, which follows the newest branch.
 */
import type { CommandContext } from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { showLoadedSession } from "./session-handlers";

/** Why the session can't be refreshed right now, or null when it can. */
function refusal(state: AppState, deps: AppDeps): string | null {
    const session = state.session;
    if (!session) return "no session to refresh";
    // A turn writes to the object it started with; swapping it out mid-turn
    // would drop the rest of that reply from the saved branch.
    if (state.busy || deps.live.feed?.isRunning(session.id)) return "can't refresh while a turn is running";
    if (!session.isBehindDisk()) return "already up to date";
    return null;
}

export function createRefreshHandlers(state: AppState, deps: AppDeps): Pick<CommandContext, "refreshSession"> {
    return {
        async refreshSession() {
            const { history, tui, manager } = deps;
            const reason = refusal(state, deps);
            if (reason) {
                history.addSystem(reason);
                tui.requestRender();
                return;
            }
            const before = state.session!.entries().length;
            try {
                const fresh = await manager.open(state.session!.id);
                const added = fresh.entries().length - before;
                showLoadedSession(state, deps, fresh, [`refreshed session ${fresh.id} · ${added} new`]);
            } catch (err) {
                history.addError(`refresh failed: ${(err as Error).message}`);
            }
            tui.requestRender();
        },
    };
}
