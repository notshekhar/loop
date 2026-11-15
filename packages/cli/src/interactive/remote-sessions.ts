/**
 * Other machines in the TUI: `/hosts` and `/rc`.
 *
 * `/hosts` is the switcher the phone and the desktop already have. Pair
 * another machine running `loop serve` (or `/rc` in its loop), pick it, pick
 * one of its sessions, and that session opens here as a slot like any other:
 * Ctrl+S lists it, and typing into it sends to that machine. The turn RUNS
 * there. This side renders the host's event stream through the same
 * `wireTurnEmitter` a local turn uses, so a remote transcript looks the same as
 * a local one.
 *
 * `/rc` is the other direction: it makes this machine pairable (the same
 * server `loop serve` runs), prints the link and a QR code for the phone, and
 * `/rc off` stops it.
 *
 * A remote session runs no local commands. The ones that move you somewhere
 * else (/hosts, /new, /resume) work. Everything that would act on THIS machine
 * (/model, `!cmd`, …) is refused, rather than silently changing a local
 * session nobody is looking at.
 */
import { manageHosts } from "./remote-sessions/hosts";
import { remoteControl } from "./remote-sessions/rc";
import { remoteRunner } from "./remote-sessions/runner";
import { createRemoteState, type RemoteSessions, type RemoteSessionsHost } from "./remote-sessions/state";
import { followServerTurn } from "./remote-sessions/turn";

export type { RemoteSessions, RemoteSessionsHost } from "./remote-sessions/state";

export function createRemoteSessions(host: RemoteSessionsHost): RemoteSessions {
    const state = createRemoteState(host);
    host.roster.setRemoteRunner(remoteRunner(state));
    return {
        manageHosts: (args) => manageHosts(state, args),
        remoteControl: (args) => remoteControl(state, args),
        followServerTurn: (sessionId) => followServerTurn(state, sessionId),
        dispose: () => {
            for (const c of state.clients.values()) c.close();
            state.clients.clear();
            host.deps.live.feed = null;
            state.rc?.stop();
            state.rc = null;
        },
    };
}
