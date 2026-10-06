import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which session the code running right now belongs to.
 *
 * The interactive bridges (ask, approvals, MCP elicitation) are single globals
 * — core cannot depend on a UI — but a question has to reach whoever is
 * watching THAT session, and several sessions can be mid-turn in one process
 * at once: the RPC server's clients, and the TUI's background sessions. A
 * module variable would answer whichever turn started last; async-local
 * storage follows the actual call, through every await inside runTurn.
 */
const scope = new AsyncLocalStorage<string>();

/** Run `fn` (and everything it awaits) as belonging to session `sessionId`. */
export function runInSession<T>(sessionId: string, fn: () => T): T {
    return scope.run(sessionId, fn);
}

/** The session the current call chain belongs to, if any. */
export function currentSessionId(): string | undefined {
    return scope.getStore();
}
