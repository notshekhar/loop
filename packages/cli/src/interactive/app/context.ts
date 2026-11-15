/**
 * The handful of objects nearly every startup step touches, gathered into
 * one value so a step takes `core` instead of a dozen parameters.
 */
import type { TuiAltScreen } from "@notshekhar/loop-tui";
import type { CommandRegistry, CostTracker, ProviderId, SessionManager } from "@notshekhar/loop-core";
import type { ChatHistory } from "../components/chat-history";
import type { StatusLine } from "../components/status-line";
import type { TodoPanel } from "../components/todo-panel";
import type { ShellsPanel } from "../components/shells-panel";
import type { SharedState, SlotManager } from "../slots";
import type { AppState } from "../state";
import type { SessionRoster } from "../session-roster";
import type { RemoteSessions } from "../remote-sessions";
import type { TeamSessions } from "../team-sessions";
import type { StatusLineRefresher } from "../status-line-refresh";

export interface InteractiveOptions {
    modelId?: string;
    provider?: ProviderId;
    cwd: string;
    sessionId?: string;
    version?: string;
}

/**
 * Built after the command context; everything that reaches them before then
 * is a closure that only runs after startup.
 */
export interface LateBound {
    roster: SessionRoster | null;
    remoteSessions: RemoteSessions | null;
    teamSessions: TeamSessions | null;
    /** The ticker is created after the shells panel that has to restart it. */
    syncTicker: () => void;
}

export interface AppCore {
    opts: InteractiveOptions;
    tui: TuiAltScreen;
    commands: CommandRegistry;
    manager: SessionManager;
    slots: SlotManager;
    shared: SharedState;
    state: AppState;
    /** The foreground session's components: each forwards to whichever slot is on screen. */
    history: ChatHistory;
    todoPanel: TodoPanel;
    tracker: CostTracker;
    queuedMessages: string[];
    statusLine: StatusLine;
    shellsPanel: ShellsPanel;
    statusLineRefresher: StatusLineRefresher;
    late: LateBound;
}

export function rosterOf(core: AppCore): SessionRoster {
    if (!core.late.roster) throw new Error("session roster used before startup finished");
    return core.late.roster;
}
