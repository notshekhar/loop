/**
 * Who runs a team's turns, and how the rest of the process hears about them.
 *
 * A member's turns run in whatever process hosts the team — the TUI (each
 * member a background session you can Ctrl+S to), `loop serve` or the
 * desktop app (each member a session the RPC server runs, so every client
 * sees it live). That process registers a TeamRuntime; the team tools only
 * ever talk to that interface, so they never need to know which one it is.
 *
 * Delivery is the one rule that matters: mail to a thread that is idle starts
 * a turn in it; mail to a thread mid-turn waits in its inbox and is handed to
 * the model before its next step (agent/turn.ts), or — if the turn ends first
 * — starts the next turn when the host calls `wakeTeamInbox` on the way out.
 */
import { onLedgerRow } from "../sessions/cost-ledger";
import { inboxCount, isTeamStopped, sessionTitle, takeInbox, teamOf, type TeamMessage } from "./store";

/** One teammate as a turn's opening card shows them. */
export interface TeamPeer {
    readonly id: string;
    readonly title: string;
}

/** A team message as it reaches a thread (transcript, model and every client). */
export interface TeamMailView {
    readonly id: number;
    readonly from: TeamPeer;
    readonly kind: "message" | "report" | "update";
    readonly text: string;
    readonly ts: number;
    /** Sent to the whole team rather than this thread alone. */
    readonly broadcast?: boolean;
}

/**
 * Why a turn the team started is running — rides on its opening user entry,
 * so a client draws a card ("Started by Add CSV export", "Message from
 * Export button") instead of a user bubble the user never typed.
 */
export interface TeamTurnMeta {
    readonly kind: "spawn" | "mail";
    readonly teamId: string;
    /** spawn: the lead that started this member. */
    readonly from?: TeamPeer;
    /** spawn: this thread's own title. */
    readonly title?: string;
    /** spawn: the named agent the lead chose to run it as. */
    readonly agent?: string;
    /** mail: what arrived. */
    readonly mail?: readonly TeamMailView[];
    /** Delivered between two steps of a turn already running, not as a turn of its own. */
    readonly midTurn?: boolean;
}

export interface TeamRuntime {
    /** Run `input` as a turn in this session now. Only called while it is idle. */
    deliver(sessionId: string, input: string, team: TeamTurnMeta): void | Promise<void>;
    isRunning(sessionId: string): boolean;
    /** Stop the turn running in this session, if any. */
    cancel(sessionId: string): void;
}

let runtime: TeamRuntime | null = null;
let runtimeOwner: unknown = null;

/**
 * Register the process's runtime. The first claim wins: the TUI claims at
 * startup, and the `/rc` server it embeds must not take it over (its sessions
 * are the TUI's). `owner` lets the claimant release it again.
 */
export function claimTeamRuntime(owner: unknown, rt: TeamRuntime): boolean {
    if (runtime) return false;
    runtime = rt;
    runtimeOwner = owner;
    return true;
}

export function releaseTeamRuntime(owner: unknown): void {
    if (runtimeOwner !== owner) return;
    runtime = null;
    runtimeOwner = null;
}

export function getTeamRuntime(): TeamRuntime | null {
    return runtime;
}

// ── change notices ─────────────────────────────────────────────────────────

/**
 * Something about a team changed. `kind` says what, so a listener can pick:
 * `members` (someone joined or moved state — redraw the panel and the list),
 * `activity` (what a member is doing), `cost` (a member spent money).
 */
export interface TeamChange {
    readonly teamId: string;
    readonly kind: "members" | "activity" | "cost" | "board";
    readonly sessionId?: string;
}

const changeListeners = new Set<(change: TeamChange) => void>();

export function onTeamChange(listener: (change: TeamChange) => void): () => void {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

/** How often the chatty kinds (activity, cost) may reach listeners, per team. */
const CHATTY_MS = 1000;
const chattyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const chattyPending = new Map<string, TeamChange>();

export function emitTeamChange(change: TeamChange): void {
    if (change.kind === "members" || change.kind === "board") {
        for (const listener of changeListeners) listener(change);
        return;
    }
    // Activity and cost move with every tool call and every step; a phone
    // redrawing its panel for each would do nothing else. At most one per
    // second per team, carrying the latest.
    const key = `${change.teamId}:${change.kind}`;
    chattyPending.set(key, change);
    if (chattyTimers.has(key)) return;
    const timer = setTimeout(() => {
        chattyTimers.delete(key);
        const latest = chattyPending.get(key);
        chattyPending.delete(key);
        if (latest) for (const listener of changeListeners) listener(latest);
    }, CHATTY_MS);
    (timer as { unref?: () => void }).unref?.();
    chattyTimers.set(key, timer);
}

// A member's spend is summed when asked (store.teamCost), so its lead has to
// be told there is something new. One listener for the whole process.
onLedgerRow((sessionPub) => {
    if (changeListeners.size === 0) return;
    const team = teamOf(sessionPub);
    if (team) emitTeamChange({ teamId: team.teamId, kind: "cost", sessionId: sessionPub });
});

// ── mail ───────────────────────────────────────────────────────────────────

/** Turn stored mail into what a thread is shown. */
export function mailViews(messages: readonly TeamMessage[]): TeamMailView[] {
    return messages
        .filter((m): m is TeamMessage & { kind: "message" | "report" | "update" } => m.kind !== "board")
        .map((m) => ({
            id: m.id,
            from: { id: m.from, title: sessionTitle(m.from) },
            kind: m.kind,
            text: m.body,
            ts: m.ts,
        }));
}

/** The mail as the model reads it: one tagged block per message. */
export function formatMailForModel(mail: readonly TeamMailView[]): string {
    return mail
        .map((m) => {
            const tag = m.kind === "report" ? "team-report" : m.kind === "update" ? "team-update" : "team-message";
            return `<${tag} from="${escapeAttr(m.from.title)}" id="${m.from.id}">\n${m.text.trim()}\n</${tag}>`;
        })
        .join("\n\n");
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Waiters inside wait_for_team, keyed by the session that is waiting. */
const mailWaiters = new Map<string, Set<() => void>>();

/** Resolve as soon as `sessionId` has mail or a teammate moves state. */
export function nudgeWaiters(sessionId?: string): void {
    if (sessionId === undefined) {
        for (const set of mailWaiters.values()) for (const wake of set) wake();
        return;
    }
    for (const wake of mailWaiters.get(sessionId) ?? []) wake();
}

export function addWaiter(sessionId: string, wake: () => void): () => void {
    let set = mailWaiters.get(sessionId);
    if (!set) {
        set = new Set();
        mailWaiters.set(sessionId, set);
    }
    set.add(wake);
    return () => {
        set!.delete(wake);
        if (set!.size === 0) mailWaiters.delete(sessionId);
    };
}

/**
 * Sessions with a team turn in progress in this process, whoever started it.
 * The runtime's own `isRunning` only knows the turns IT started; a lead's
 * turn the user typed is just as busy, and handing it a second turn would
 * race the first — and steal the mail its wait_for_team is collecting.
 */
const activeTurns = new Set<string>();

export function markTurnActive(sessionId: string, active: boolean): void {
    if (active) activeTurns.add(sessionId);
    else activeTurns.delete(sessionId);
}

export function isTurnActive(sessionId: string): boolean {
    return activeTurns.has(sessionId);
}

/** Sessions whose turn is sitting in wait_for_team (they take mail there). */
const waitingSessions = new Set<string>();

export function markWaiting(sessionId: string, waiting: boolean): void {
    if (waiting) waitingSessions.add(sessionId);
    else waitingSessions.delete(sessionId);
}

export function isWaiting(sessionId: string): boolean {
    return waitingSessions.has(sessionId);
}

/**
 * Hand a thread its mail if it can take it now: an idle thread gets a turn
 * with the mail as its prompt. A busy one is left alone — it reads its inbox
 * before its next step, or in wait_for_team, or here again once its turn ends
 * (every runtime calls this as a turn settles).
 */
export function wakeTeamInbox(sessionId: string): boolean {
    const rt = runtime;
    if (!rt) return false;
    const team = teamOf(sessionId);
    if (!team || isTeamStopped(team.teamId)) return false;
    if (rt.isRunning(sessionId) || activeTurns.has(sessionId)) {
        nudgeWaiters(sessionId);
        return false;
    }
    if (inboxCount(sessionId) === 0) return false;
    const mail = mailViews(takeInbox(sessionId));
    if (mail.length === 0) return false;
    void Promise.resolve(
        rt.deliver(sessionId, formatMailForModel(mail), { kind: "mail", teamId: team.teamId, mail }),
    ).catch(() => {});
    return true;
}
