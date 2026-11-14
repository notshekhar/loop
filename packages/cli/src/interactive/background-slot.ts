/**
 * Open a stored session in a background slot — a live session you are not
 * looking at, whose turns run exactly as a typed turn would and which Ctrl+S
 * lists beside the others. Thread teams (team-sessions.ts) and `/btw` side
 * threads (btw-threads.ts) both run their sessions this way.
 */
import {
    CostTracker,
    parseModelId,
    type ProviderId,
    type Session,
    type SessionManager,
    type ThinkingLevel,
} from "@notshekhar/loop-core";
import type { TUI } from "@notshekhar/loop-tui";
import { ChatHistory } from "./components/chat-history";
import { TodoPanel } from "./components/todo-panel";
import type { AppDeps } from "./deps";
import { renderSessionBranch } from "./replay";
import type { SessionSlot, SlotManager } from "./slots";

export interface BackgroundSlotHost {
    slots: SlotManager;
    deps: AppDeps;
    tui: TUI;
    manager: SessionManager;
}

/** How the slot's turns run; anything left out follows the foreground slot. */
export interface BackgroundRunChoices {
    readonly modelId?: string;
    readonly thinkingLevel?: ThinkingLevel;
    readonly agent?: string;
}

function providerOf(model: string, recorded: ProviderId): ProviderId {
    try {
        return parseModelId(model).provider as ProviderId;
    } catch {
        return recorded;
    }
}

function seededTracker(session: Session): CostTracker {
    const tracker = new CostTracker();
    try {
        tracker.seedFromSession(session);
    } catch {
        // an unseeded tracker still bills this process's turns
    }
    return tracker;
}

/** How a session's slot is opened when it has none. */
export interface SlotOpening {
    /** How its turns run; anything left out follows the foreground slot. */
    readonly choose?: (session: Session) => BackgroundRunChoices;
    /** Drawn above its replayed transcript — what this session is, for when you switch to it. */
    readonly banner?: string;
}

/** The live slot for a session, else one opened in the background as `opening` says. */
export type SlotFor = (sessionId: string, opening?: SlotOpening) => Promise<SessionSlot>;

/**
 * One `SlotFor` per app. Opens of the same session at the same moment share
 * one slot: two Session objects for one conversation would each append to
 * their own branch.
 */
export function createSlotOpener(host: BackgroundSlotHost): SlotFor {
    const opening = new Map<string, Promise<SessionSlot>>();
    return (sessionId, how = {}) => {
        const live = host.slots.bySessionId(sessionId);
        if (live) return Promise.resolve(live);
        const already = opening.get(sessionId);
        if (already) return already;
        const opened = openBackgroundSlot(host, sessionId, how).finally(() => opening.delete(sessionId));
        opening.set(sessionId, opened);
        return opened;
    };
}

/** A new background slot for `sessionId`. */
async function openBackgroundSlot(
    host: BackgroundSlotHost,
    sessionId: string,
    { choose = () => ({}), banner }: SlotOpening,
): Promise<SessionSlot> {
    const { slots, deps, tui, manager } = host;
    // The /rc server's copy when it has one: two Session objects for one
    // conversation each append to their own branch.
    const session = deps.live.feed?.openSession(sessionId) ?? (await manager.open(sessionId));
    const choices = choose(session);
    const model = choices.modelId || session.lastModel() || session.info.model;
    const template = slots.foreground;
    const history = new ChatHistory(tui, session.info.cwd);
    const todoPanel = new TodoPanel();
    const slot = slots.add({
        cwd: session.info.cwd,
        modelId: model,
        provider: providerOf(model, session.info.provider),
        thinkingLevel: choices.thinkingLevel ?? template.thinkingLevel,
        agent: choices.agent ?? template.agent,
        oneShotAgent: null,
        session,
        latestContextTokens: 0,
        busy: false,
        abort: new AbortController(),
        pendingInjection: null,
        startupHooksDone: null,
        pendingPlan: null,
        planModeViaCycle: false,
        history,
        todoPanel,
        tracker: seededTracker(session),
    });
    if (banner) history.addSystem(banner);
    renderSessionBranch(session, history, model, todoPanel);
    return slot;
}
