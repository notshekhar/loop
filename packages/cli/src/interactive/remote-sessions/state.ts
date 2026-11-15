/**
 * What every part of `/hosts` and `/rc` shares: the host the app hands in, the
 * open sockets, the running `/rc` server and the turns being drawn.
 */
import {
    TURN_EVENT_NAMES,
    type asTurnEmitter,
    type AskAnswer,
    type AskQuestion,
    type CommandContext,
    type CommandRegistry,
    type Entry,
    type RemoteHostClient,
    type ServeHandle,
} from "@notshekhar/loop-core";
import type { TUI } from "@notshekhar/loop-tui";
import type { AppDeps } from "../deps";
import type { SessionRoster } from "../session-roster";
import type { SessionSlot, SlotManager } from "../slots";

/** The stream parts a drawn turn renders; the rest are session bookkeeping. */
export const TURN_EVENTS: ReadonlySet<string> = new Set<string>(TURN_EVENT_NAMES);

export interface RemoteSessionsHost {
    slots: SlotManager;
    roster: SessionRoster;
    /** The app's deps (act on the foreground). */
    deps: AppDeps;
    ctx: CommandContext;
    commands: CommandRegistry;
    tui: TUI;
    /** The TUI's own question UI — a remote turn's `ask` opens it here. */
    ask: (questions: AskQuestion[], opts?: { signal?: AbortSignal }) => Promise<AskAnswer[]>;
    version?: string;
}

export interface RemoteSessions {
    manageHosts(args: string): Promise<void>;
    remoteControl(args: string): Promise<void>;
    /** Draw a turn the `/rc` server is running in a session open here. */
    followServerTurn(sessionId: string): void;
    /** Close every socket and stop `/rc`. */
    dispose(): void;
}

/** A remote turn being drawn in a slot here. */
export interface RemoteTurn {
    startedAt: number;
    errors: unknown[];
    emitter: ReturnType<typeof asTurnEmitter>;
    signal: AbortSignal;
    dispose(): void;
}

export interface RemoteState {
    readonly host: RemoteSessionsHost;
    /** One socket per paired host, by host id. */
    readonly clients: Map<string, RemoteHostClient>;
    readonly turns: WeakMap<SessionSlot, RemoteTurn>;
    /** Sends this TUI made whose turn has not started yet — so it is not announced as someone else's. */
    readonly sentHere: WeakSet<SessionSlot>;
    rc: ServeHandle | null;
    /** Whether the running remote control offers paired devices the terminal. */
    rcTerminal: boolean;
}

export function createRemoteState(host: RemoteSessionsHost): RemoteState {
    return {
        host,
        clients: new Map(),
        turns: new WeakMap(),
        sentHere: new WeakSet(),
        rc: null,
        rcTerminal: true,
    };
}

/** A line in the foreground transcript. */
export function say(state: RemoteState, text: string): void {
    state.host.deps.history.addSystem(text);
    state.host.tui.requestRender();
}

export function providerOf(modelId: string): string {
    const slash = modelId.indexOf("/");
    return slash > 0 ? modelId.slice(0, slash) : "";
}

/** The first thing the user said in a branch — a title for a session with no name. */
export function firstUserText(entries: Entry[]): string {
    for (const e of entries) {
        if (e.type === "message" && e.role === "user")
            return String(e.content ?? "")
                .split("\n")[0]!
                .slice(0, 80);
    }
    return "";
}
