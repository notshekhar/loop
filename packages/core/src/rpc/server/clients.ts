import type { RpcNotification } from "../protocol";
import type { Transport } from "./active-session";

/** What `session.status` tells every client (see `announce`). */
export interface SessionStatusNotice {
    readonly sessionId: string;
    /** `updated`: another process wrote to the session; re-read it. */
    readonly change: "running" | "created" | "renamed" | "archived" | "deleted" | "team" | "updated";
    readonly running?: boolean;
    /** change "team": which team, and what moved in it (teams/runtime.ts TeamChange). */
    readonly teamId?: string;
    readonly teamChange?: "members" | "activity" | "cost" | "board" | "budget";
}

/** Tells every client about a session change — the seam handlers announce through. */
export type Announce = (notice: SessionStatusNotice) => void;

/** Every connected client, for host-wide notices. */
export class ClientRegistry {
    private transports = new Set<Transport>();

    add(transport: Transport): void {
        this.transports.add(transport);
    }

    remove(transport: Transport): void {
        this.transports.delete(transport);
    }

    /**
     * Tell EVERY client that a session changed — not just its subscribers.
     *
     * Turn events only reach clients attached to that session, so a list (the
     * phone's home, a sidebar) learned of a turn started elsewhere — or of one
     * ending after its socket had been replaced — only on its next unrelated
     * refresh, and showed "Working" until then. One small notice per change
     * keeps every list true. Additive: an older client ignores the method.
     */
    announce(notice: SessionStatusNotice): void {
        const msg: RpcNotification = { jsonrpc: "2.0", method: "session.status", params: notice };
        // Next tick: the request that caused it (a create, a rename) gets its
        // reply first, then the news — the order a client reads them in.
        setTimeout(() => {
            for (const t of this.transports) {
                try {
                    t.send(msg);
                } catch {
                    // A dying transport is the close handler's problem.
                }
            }
        }, 0);
    }
}
