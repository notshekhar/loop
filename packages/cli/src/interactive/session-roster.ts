/**
 * The app side of several live sessions: what a session working out of sight
 * may and may not touch, what the screen does when you switch, and the Ctrl+S
 * switcher. The bookkeeping itself (who is foreground, statuses, parked
 * prompts) is SlotManager's — see slots.ts for the model.
 */
import {
    contextTokensFromUsage,
    countLiveStatuses,
    CostTracker,
    currentSessionId,
    sortLiveRows,
    type CommandContext,
    type LiveStatus,
    type SessionManager,
    type TeamTurnMeta,
    type UsageBlock,
} from "@notshekhar/loop-core";
import type { Editor, SelectItem, TUI } from "@notshekhar/loop-tui";
import { ChatHistory } from "./components/chat-history";
import { TodoPanel } from "./components/todo-panel";
import type { StatusLine } from "./components/status-line";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import { makeStateView, type SessionSlot, type SharedState, type SlotManager } from "./slots";
import { createTurnRunner } from "./turn-runner";
import { defaultTabName, setTabName } from "./session-title";
import { showWelcomeBanner } from "./welcome";
import { showWorkspaceBanners } from "./startup";
import { accent, dim, err, ok, warn } from "./ui/text";

const GLYPH: Record<LiveStatus, string> = {
    "needs-input": "◆",
    working: "●",
    done: "✓",
    failed: "✗",
    idle: "○",
};

const STATUS_WORD: Record<LiveStatus, string> = {
    "needs-input": "needs you",
    working: "working",
    done: "done",
    failed: "failed",
    idle: "idle",
};

const paint: Record<LiveStatus, (s: string) => string> = {
    "needs-input": warn,
    working: accent,
    done: ok,
    failed: err,
    idle: dim,
};

/** "now", "4m", "2h", "3d" — the roster's age column. */
export function formatAge(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86_400)}d`;
}

/** The coloured status glyph a live session wears in every session list. */
export function liveGlyph(slot: SessionSlot): string {
    return paint[slot.status](GLYPH[slot.status]);
}

/**
 * Marks the session on screen in a list. Leads the DESCRIPTION, not the
 * label: the label column is cut to fit, and a marker at its end is the first
 * thing a long title pushes off.
 */
export const HERE = "here · ";

/** What a live session is doing, as a list row's description lead ("Running bash… · "); empty when idle. */
export function liveActivity(slot: SessionSlot): string {
    return slot.status === "idle" ? "" : `${slot.activity || STATUS_WORD[slot.status]} · `;
}

/** What a slot is called in the roster: its name, else what it was first asked. */
export function slotTitle(slot: SessionSlot): string {
    if (slot.remote) return slot.remote.title || "new session";
    const name = slot.session?.getName();
    if (name) return name;
    if (slot.firstPrompt) return slot.firstPrompt.replace(/\s+/g, " ").trim();
    return "new session";
}

/**
 * The status line's account of the OTHER sessions, or null when there are
 * none. Only states worth a glance are counted; idle ones just say they exist.
 */
export function formatSessionsChip(others: readonly SessionSlot[]): string | null {
    if (others.length === 0) return null;
    const counts = countLiveStatuses(others.map((s) => s.status));
    const parts: string[] = [];
    for (const status of ["needs-input", "working", "done", "failed"] as const) {
        if (counts[status] > 0) parts.push(paint[status](`${GLYPH[status]} ${counts[status]} ${STATUS_WORD[status]}`));
    }
    if (parts.length === 0) parts.push(dim(`${others.length} other session${others.length === 1 ? "" : "s"}`));
    return parts.join(dim(" · ")) + dim(" (ctrl+s)");
}

export interface SessionRosterHost {
    slots: SlotManager;
    shared: SharedState;
    /** The app's own deps: everything acts on the foreground. */
    deps: AppDeps;
    ctx: CommandContext;
    tui: TUI;
    editor: Editor;
    statusLine: StatusLine;
    manager: SessionManager;
    /** The loader under the transcript — screen only, no status bookkeeping. */
    indicator: { show(message?: string): void; hide(): void };
    /** Repaint the background-shells panel for the foreground session. */
    refreshShells(): void;
}

export interface SessionRoster {
    /** The submit handler for `slot`: a turn runner pinned to that session. */
    runnerFor(slot: SessionSlot): SlotRunner;
    /** Deps that act on `slot` whether or not it is on screen. */
    depsFor(slot: SessionSlot): AppDeps;
    /** An AppState view pinned to `slot`. */
    viewOf(slot: SessionSlot): AppState;
    showWorkingFor(slot: SessionSlot, message?: string): void;
    hideWorkingFor(slot: SessionSlot): void;
    ensureSessionFor(slot: SessionSlot): ReturnType<AppDeps["ensureSession"]>;
    /** Open a fresh session and bring it on screen; the current one keeps running. */
    openNew(): Promise<SessionSlot>;
    /** The Ctrl+S picker: switch to a live session, or start a new one. */
    showSwitcher(): Promise<void>;
    /**
     * Show an agent-driven prompt once the session that raised it is on
     * screen; `declined()` is the answer if its turn is cancelled first.
     */
    gated<T>(label: string, signal: AbortSignal | undefined, show: () => Promise<T>, declined: () => T): Promise<T>;
    /** Who answers what is typed into a session on another machine (remote-sessions.ts). */
    setRemoteRunner(factory: (slot: SessionSlot) => (raw: string) => Promise<void>): void;
}

/**
 * What a slot's input goes through; `chatOnly` marks a remote client's
 * message, `team` a turn the thread team started (core teams/).
 */
export type SlotRunner = (raw: string, opts?: { chatOnly?: boolean; team?: TeamTurnMeta }) => Promise<void>;

export function createSessionRoster(host: SessionRosterHost): SessionRoster {
    const { slots, shared, deps, tui, editor, statusLine, manager, indicator } = host;
    const views = new WeakMap<SessionSlot, AppState>();
    const pinned = new WeakMap<SessionSlot, AppDeps>();
    const runners = new WeakMap<SessionSlot, SlotRunner>();
    const drafts = new WeakMap<SessionSlot, string>();
    let remoteRunner: ((slot: SessionSlot) => (raw: string) => Promise<void>) | null = null;

    const viewOf = (slot: SessionSlot): AppState => {
        let v = views.get(slot);
        if (!v) {
            v = makeStateView(shared, () => slot);
            views.set(slot, v);
        }
        return v;
    };

    const showWorkingFor = (slot: SessionSlot, message?: string): void => {
        slots.setStatus(slot, "working", message ?? "Working");
        if (slots.isForeground(slot)) indicator.show(message);
    };

    const hideWorkingFor = (slot: SessionSlot): void => {
        slots.setStatus(slot, slot.busy ? "working" : "idle");
        if (slots.isForeground(slot)) indicator.hide();
    };

    const ensureSessionFor = async (slot: SessionSlot) => {
        if (slot.session) return slot.session;
        slot.session = await manager.create({ cwd: slot.cwd, provider: slot.provider, model: slot.modelId });
        if (slots.isForeground(slot)) statusLine.setSession(slot.session.id);
        return slot.session;
    };

    /**
     * `obj`, except its methods do nothing while `slot` is out of sight. For
     * the screen's singletons (status line, shells panel): a background turn
     * finishing must not repaint them with ITS plan mode or ITS shells.
     */
    const whileOnScreen = <T extends object>(slot: SessionSlot, obj: T): T =>
        new Proxy(obj, {
            get(target, prop) {
                const value = Reflect.get(target, prop, target);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => (slots.isForeground(slot) ? value.apply(target, args) : undefined);
            },
        });

    const depsFor = (slot: SessionSlot): AppDeps => {
        const existing = pinned.get(slot);
        if (existing) return existing;
        const onScreen = () => slots.isForeground(slot);
        // A menu this session opens (the plan follow-up, goal mode's
        // confirmations) waits until you are looking at it; cancelled while
        // waiting, it resolves to what dismissing it would have.
        const whenOnScreen =
            <A extends unknown[], R>(
                label: (...args: A) => string | undefined,
                show: (...args: A) => Promise<R>,
                dismissed: R,
            ) =>
            async (...args: A): Promise<R> =>
                (await slots.waitForForeground(slot, label(...args) ?? "choice", slot.abort.signal))
                    ? show(...args)
                    : dismissed;
        // Out of sight there is no line to repaint, but the context size the
        // usage reports is this session's and is kept for when it is back.
        const refresh =
            (onScreenRefresh: (usage?: UsageBlock) => void) =>
            (usage?: UsageBlock): void => {
                if (onScreen()) onScreenRefresh(usage);
                else if (usage) slot.latestContextTokens = contextTokensFromUsage(usage);
            };
        const d: AppDeps = {
            ...deps,
            history: slot.history,
            todoPanel: slot.todoPanel,
            tracker: slot.tracker,
            queuedMessages: slot.queue,
            statusLine: whileOnScreen(slot, deps.statusLine),
            shellsPanel: whileOnScreen(slot, deps.shellsPanel),
            // Submitting on this session's behalf (the queue draining, goal
            // mode continuing) goes to THIS session's runner, not whichever
            // one the editor happens to be showing.
            editor: new Proxy(editor, {
                get(target, prop) {
                    if (prop === "onSubmit") return runnerFor(slot);
                    const value = Reflect.get(target, prop, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            }),
            showWorking: (message) => showWorkingFor(slot, message),
            hideWorking: () => hideWorkingFor(slot),
            refreshStatusLine: refresh(deps.refreshStatusLine),
            refreshStatusLineCtx: refresh(deps.refreshStatusLineCtx),
            renderPending: () => {
                if (onScreen()) deps.renderPending();
            },
            scrollTranscriptToEnd: () => {
                if (onScreen()) deps.scrollTranscriptToEnd();
            },
            selectOnce: whenOnScreen((_items, title) => title, deps.selectOnce, null),
            searchOnce: whenOnScreen((_items, title) => title, deps.searchOnce, null),
            toggleOnce: whenOnScreen((_values, _initial, title) => title, deps.toggleOnce, null),
            promptOnce: whenOnScreen((label) => label ?? "input", deps.promptOnce, ""),
            ensureSession: () => ensureSessionFor(slot),
            isForeground: onScreen,
            settleTurn: (failed) => slots.settle(slot, failed),
        };
        pinned.set(slot, d);
        return d;
    };

    const runnerFor = (slot: SessionSlot): SlotRunner => {
        let run = runners.get(slot);
        if (!run) {
            // A session on another machine runs its turns there; this side
            // only forwards what is typed and renders what comes back.
            const runner =
                slot.remote && remoteRunner ? remoteRunner(slot) : createTurnRunner(viewOf(slot), depsFor(slot), host.ctx);
            run = (raw: string, opts?: { chatOnly?: boolean; team?: TeamTurnMeta }) => {
                const text = raw.trim();
                if (!slot.firstPrompt && text && !text.startsWith("/") && !text.startsWith("!")) {
                    slot.firstPrompt = text.split("\n")[0].slice(0, 120);
                }
                return runner(raw, opts);
            };
            runners.set(slot, run);
        }
        return run;
    };

    /** A session nobody typed into and nothing is running in is not worth keeping. */
    const isEmpty = (slot: SessionSlot): boolean =>
        !slot.session &&
        !slot.remote && !slot.busy && slot.queue.length === 0 && slot.waiters.size === 0;

    // The screen follows the foreground. Everything here is repaint: the
    // per-session components already hold their own content.
    slots.onSwitch((from, to) => {
        drafts.set(from, editor.getText());
        editor.setText(drafts.get(to) ?? "");
        if (isEmpty(from)) slots.remove(from);

        statusLine.setModel(to.modelId);
        statusLine.setAgent(to.agent);
        statusLine.setThinking(to.thinkingLevel);
        // A remote session says which machine its folder is on.
        statusLine.setCwd(to.remote ? `${to.remote.host.label}:${to.cwd}` : to.cwd);
        statusLine.setSession(to.remote?.sessionId ?? to.session?.id ?? "unsaved");
        deps.refreshStatusLine();
        if (to.busy) indicator.show(to.activity || "Generating");
        else indicator.hide();
        deps.renderPending();
        host.refreshShells();
        setTabName(deps, (to.remote ? slotTitle(to) : to.session?.getName()) || defaultTabName());

        deps.scrollTranscriptToEnd();
        tui.invalidate();
        tui.requestRender(true);

        // Commands queued while it was out of sight run now that it is not.
        if (!to.busy && to.queue.length > 0) {
            const next = to.queue.shift()!;
            deps.renderPending();
            void runnerFor(to)(next);
        }
    });

    slots.onChange(() => {
        statusLine.setSessions(formatSessionsChip(slots.all().filter((s) => !slots.isForeground(s))));
        tui.requestRender();
    });

    const openNew = async (): Promise<SessionSlot> => {
        // A new session is a session on THIS machine: when another machine's
        // is on screen, its folder and model say nothing about here, so the
        // most recent local session is the template instead.
        const from = slots.foreground.remote
            ? ([...slots.all()].reverse().find((s) => !s.remote) ?? slots.all()[0]!)
            : slots.foreground;
        const slot = slots.add({
            cwd: from.cwd,
            modelId: from.modelId,
            provider: from.provider,
            thinkingLevel: from.thinkingLevel,
            agent: from.agent,
            oneShotAgent: null,
            session: null,
            latestContextTokens: 0,
            busy: false,
            abort: new AbortController(),
            pendingInjection: null,
            startupHooksDone: null,
            pendingPlan: null,
            planModeViaCycle: false,
            history: new ChatHistory(tui, from.cwd),
            todoPanel: new TodoPanel(),
            tracker: new CostTracker(),
        });
        slots.switchTo(slot);
        // The same opening a fresh loop has, so a new session looks like one.
        showWelcomeBanner(slot.history, viewOf(slot), depsFor(slot));
        await showWorkspaceBanners(slot.history, slot.cwd);
        tui.requestRender();
        return slot;
    };

    const showSwitcher = async (): Promise<void> => {
        const NEW = "\x00new";
        const now = Date.now();
        const rows = sortLiveRows(slots.all());
        const items: SelectItem[] = [
            {
                value: NEW,
                label: "+ New session",
                description: slots.foreground.busy ? "this one keeps running" : "start fresh",
            },
            ...rows.map((slot) => {
                return {
                    value: String(slot.key),
                    label: `${liveGlyph(slot)} ${slotTitle(slot)}`,
                    // The machine leads the description: a host name is long,
                    // and the label column is cut to fit.
                    description: `${slots.isForeground(slot) ? HERE : ""}${slot.remote ? `on ${slot.remote.host.label} · ` : ""}${deps.team?.teamLabel(slot.session?.id) ?? ""}${liveActivity(slot)}${formatAge(now - slot.lastActivityAt)}`,
                };
            }),
        ];
        // The cursor starts where you most likely want to go: a session that
        // is waiting on you, else "new".
        const firstWaiting = rows.findIndex((s) => s.status === "needs-input" && !slots.isForeground(s));
        const pick = await deps.searchOnce(items, `Sessions · ${slots.all().length} live`, {
            initialIndex: firstWaiting >= 0 ? firstWaiting + 1 : 0,
        });
        if (!pick) return;
        if (pick.value === NEW) {
            await openNew();
            return;
        }
        const target = slots.all().find((s) => String(s.key) === pick.value);
        if (target) slots.switchTo(target);
    };

    const gated = async <T>(
        label: string,
        signal: AbortSignal | undefined,
        show: () => Promise<T>,
        declined: () => T,
    ): Promise<T> => {
        // The asking turn runs inside runInSession; outside any turn (an MCP
        // server asking on its own) the question belongs to what is on screen.
        const slot = slots.bySessionId(currentSessionId()) ?? slots.foreground;
        return (await slots.waitForForeground(slot, label, signal)) ? show() : declined();
    };

    return {
        runnerFor,
        depsFor,
        viewOf,
        showWorkingFor,
        hideWorkingFor,
        ensureSessionFor,
        openNew,
        showSwitcher,
        gated,
        setRemoteRunner: (factory) => {
            remoteRunner = factory;
        },
    };
}
