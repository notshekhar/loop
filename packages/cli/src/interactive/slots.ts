/**
 * Live sessions in one interactive loop, and which of them is on screen.
 *
 * A slot is one conversation's runtime: its session, its turn (busy flag,
 * abort controller, queue), its transcript component, its checklist, its
 * cost tracker. Several can be mid-turn at once — `/new` while a turn runs, or
 * the Ctrl+S switcher, sends the running one to the background instead of
 * killing it — and exactly one is the FOREGROUND: the one the screen shows and
 * the keyboard talks to.
 *
 * Most of the app was written for one session and reads `state.busy`,
 * `deps.history`, … from closures built once at startup. Rather than thread a
 * slot through every handler, those references FORWARD: `state` is a view
 * whose per-session fields resolve against the foreground slot at the moment
 * they are read, and `history`/`todoPanel`/`tracker`/the queue are proxies to
 * the foreground's own instances. A handler that runs while you are looking
 * at a session therefore acts on that session, unchanged.
 *
 * The one thing that must NOT follow the foreground is work that outlives a
 * switch — a turn, its finally, the plan/goal follow-ups after it. Those take
 * a view PINNED to their own slot (`viewOf(slot)`) when they start, so a turn
 * that finishes in the background writes its ending into its own transcript
 * instead of whatever you are looking at by then.
 */
import type { CostTracker, LiveStatus, RemoteHostClient, RemoteHostRecord } from "@notshekhar/loop-core";
import type { ChatHistory } from "./components/chat-history";
import type { TodoPanel } from "./components/todo-panel";
import type { AppState } from "./state";

/** AppState fields that belong to one conversation rather than to the app. */
export const SLOT_FIELDS = [
    "cwd",
    "modelId",
    "provider",
    "thinkingLevel",
    "agent",
    "oneShotAgent",
    "session",
    "latestContextTokens",
    "busy",
    "abort",
    "pendingInjection",
    "startupHooksDone",
    "pendingPlan",
    "planModeViaCycle",
] as const satisfies readonly (keyof AppState)[];

export type SlotField = (typeof SLOT_FIELDS)[number];
export type SlotState = Pick<AppState, SlotField>;
export type SharedState = Omit<AppState, SlotField>;

export interface SessionSlot extends SlotState {
    /** Process-local id; stable for the slot's life, unlike `session` (null until the first turn). */
    readonly key: number;
    readonly history: ChatHistory;
    readonly todoPanel: TodoPanel;
    readonly tracker: CostTracker;
    /** Inputs typed while this session was busy, drained FIFO after each turn. */
    readonly queue: string[];
    /** Roster state (see LiveStatus). Kept by the manager, read by the switcher. */
    status: LiveStatus;
    /** What it is doing right now ("Running bash…"), or how it ended. */
    activity: string;
    /** Last time anything happened in it — the roster's tiebreak and age column. */
    lastActivityAt: number;
    /** First thing typed into it — its roster title until it earns a name. */
    firstPrompt?: string;
    /** Agent-driven prompts parked until this session is on screen again. */
    readonly waiters: Set<Waiter>;
    /**
     * Set when this session lives on ANOTHER machine (`/hosts`): its turns run
     * there, and this slot only renders the host's event stream and forwards
     * what is typed. `session` stays null — there is no local transcript.
     */
    remote?: RemoteLink;
}

/** A slot's tie to a session on another machine (remote-sessions.ts). */
export interface RemoteLink {
    readonly host: RemoteHostRecord;
    readonly client: RemoteHostClient;
    readonly sessionId: string;
    /** The session's name on the host, else its first message. */
    title: string;
    /** The model its turns run on there. */
    model: string;
    /** Last event seq applied — what a reconnect resumes from. */
    seq: number;
    /** Stop listening (the slot was dropped). */
    dispose(): void;
}

interface Waiter {
    resolve: (onScreen: boolean) => void;
    label: string;
}

/**
 * A stand-in for whatever `get()` returns at the moment it is used.
 *
 * Methods are bound to the real target, so a component's own `this` (and any
 * field it keeps) is the real instance, never the proxy. Used for the
 * foreground's components, which are mounted once in the frame and handed to
 * dozens of closures at startup.
 */
export function forwardTo<T extends object>(get: () => T): T {
    return new Proxy({} as T, {
        get(_t, prop) {
            const target = get();
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
        set(_t, prop, value) {
            return Reflect.set(get(), prop, value);
        },
        has(_t, prop) {
            return Reflect.has(get(), prop);
        },
        getPrototypeOf() {
            return Reflect.getPrototypeOf(get());
        },
        ownKeys() {
            return Reflect.ownKeys(get());
        },
        getOwnPropertyDescriptor(_t, prop) {
            const desc = Reflect.getOwnPropertyDescriptor(get(), prop);
            // A proxy may not report a non-configurable property its own
            // (empty) target does not have; everything is configurable here.
            return desc ? { ...desc, configurable: true } : undefined;
        },
    });
}

/**
 * An AppState whose per-session fields live on `slot()` and whose app-wide
 * fields live on `shared`. `slot` is a function so the same view can follow
 * the foreground (`() => manager.foreground`) or stay put (`() => slot`).
 */
export function makeStateView(shared: SharedState, slot: () => SessionSlot): AppState {
    const view = {} as AppState;
    for (const key of Object.keys(shared) as (keyof SharedState)[]) {
        Object.defineProperty(view, key, {
            enumerable: true,
            get: () => shared[key],
            set: (v) => {
                (shared as Record<string, unknown>)[key] = v;
            },
        });
    }
    for (const key of SLOT_FIELDS) {
        Object.defineProperty(view, key, {
            enumerable: true,
            get: () => slot()[key],
            set: (v) => {
                (slot() as unknown as Record<string, unknown>)[key] = v;
            },
        });
    }
    return view;
}

export type SlotInit = SlotState & Pick<SessionSlot, "history" | "todoPanel" | "tracker" | "remote">;

export class SlotManager {
    private readonly list: SessionSlot[] = [];
    private fg: SessionSlot;
    private nextKey = 1;
    private readonly changeListeners = new Set<() => void>();
    private readonly switchListeners = new Set<(from: SessionSlot, to: SessionSlot) => void>();

    constructor(first: SlotInit) {
        this.fg = this.add(first);
    }

    get foreground(): SessionSlot {
        return this.fg;
    }

    all(): readonly SessionSlot[] {
        return this.list;
    }

    isForeground(slot: SessionSlot): boolean {
        return slot === this.fg;
    }

    bySessionId(id: string | undefined): SessionSlot | undefined {
        if (!id) return undefined;
        return this.list.find((s) => s.session?.id === id);
    }

    add(init: SlotInit): SessionSlot {
        const slot: SessionSlot = {
            ...init,
            key: this.nextKey++,
            queue: [],
            status: init.busy ? "working" : "idle",
            activity: "",
            lastActivityAt: Date.now(),
            waiters: new Set(),
        };
        this.list.push(slot);
        this.changed();
        return slot;
    }

    /**
     * Bring `slot` on screen. Listeners repaint the frame; then anything the
     * session parked while it was out of sight (an ask, an approval) is let
     * through, one at a time in arrival order, now that someone can see it.
     */
    switchTo(slot: SessionSlot): void {
        if (slot === this.fg || !this.list.includes(slot)) return;
        const from = this.fg;
        this.fg = slot;
        // Looking at a finished session is what "seen" means.
        if (slot.status === "done" || slot.status === "failed") slot.status = "idle";
        for (const l of this.switchListeners) l(from, slot);
        this.releaseWaiters(slot);
        this.changed();
    }

    /** Drop a slot from the roster. The foreground cannot be removed. */
    remove(slot: SessionSlot): boolean {
        if (slot === this.fg) return false;
        const i = this.list.indexOf(slot);
        if (i < 0) return false;
        this.list.splice(i, 1);
        for (const w of slot.waiters) w.resolve(false);
        slot.waiters.clear();
        slot.remote?.dispose();
        this.changed();
        return true;
    }

    /** Record what a slot is doing. Repaints the roster only on a real change. */
    setStatus(slot: SessionSlot, status: LiveStatus, activity?: string): void {
        slot.lastActivityAt = Date.now();
        // Parked prompts outrank everything until they are answered.
        const next = slot.waiters.size > 0 ? "needs-input" : status;
        // Activity describes work in progress. Once nothing is in progress
        // the last "Generating" is history, and a finished session showing it
        // reads as still running — the status word says it instead.
        if (next === "working" || next === "needs-input") {
            if (activity !== undefined) slot.activity = activity;
        } else {
            slot.activity = "";
        }
        if (next === slot.status) return;
        slot.status = next;
        this.changed();
    }

    /**
     * A turn finished. Seen if it is on screen; otherwise it stays marked
     * done/failed until the user switches to it.
     */
    settle(slot: SessionSlot, failed: boolean): void {
        this.setStatus(slot, slot === this.fg ? "idle" : failed ? "failed" : "done");
    }

    /**
     * Resolves true once `slot` is on screen, so an agent-driven prompt can
     * open where the user will see it. A background session's prompt parks
     * here (the slot shows as needs-input) rather than taking over whatever
     * the user is looking at. Resolves false if `signal` aborts first — the
     * turn was cancelled, nobody is waiting for the answer anymore.
     */
    waitForForeground(slot: SessionSlot, label: string, signal?: AbortSignal): Promise<boolean> {
        if (slot === this.fg) return Promise.resolve(true);
        if (signal?.aborted) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
            const waiter: Waiter = {
                label,
                resolve: (onScreen) => {
                    signal?.removeEventListener("abort", onAbort);
                    slot.waiters.delete(waiter);
                    resolve(onScreen);
                },
            };
            const onAbort = () => {
                waiter.resolve(false);
                this.setStatus(slot, slot.busy ? "working" : "idle");
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            slot.waiters.add(waiter);
            this.setStatus(slot, "needs-input", `Waiting: ${label}`);
        });
    }

    /** Called with nothing whenever the roster changed (status, add, remove, switch). */
    onChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    onSwitch(listener: (from: SessionSlot, to: SessionSlot) => void): () => void {
        this.switchListeners.add(listener);
        return () => this.switchListeners.delete(listener);
    }

    private releaseWaiters(slot: SessionSlot): void {
        // Released together: the ask and approval bridges each chain their
        // own prompts, so two released asks still open one after the other.
        const waiting = [...slot.waiters];
        slot.waiters.clear();
        if (waiting.length > 0) this.setStatus(slot, slot.busy ? "working" : "idle");
        for (const w of waiting) w.resolve(true);
    }

    private changed(): void {
        for (const l of this.changeListeners) l();
    }
}
