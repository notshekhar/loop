/**
 * Thread teams: an agent splits a job across threads that run in parallel,
 * know about each other, message each other, and report back to the thread
 * that started them. Behind the `threadTeams` setting, off by default.
 *
 *   store.ts    who is in which team, their states, the mail (SQLite)
 *   runtime.ts  who runs a member's turns, delivery, change notices
 *   tools.ts    spawn_threads, send_message, team_board, wait_for_team, report
 *   prompts.ts  what the model is told
 *   budget.ts   the spend cap that stops a team
 *   turn-end.ts how a turn's end reaches the panels and the lead
 */
import { getSetting } from "../settings";
import { onLedgerRow } from "../sessions/cost-ledger";
import { killSessionShells } from "../tools/utils/shell-registry";
import { isTeamOverBudget, teamBudgetUsd } from "./budget";
import { emitTeamChange, getTeamRuntime, isTurnActive, nudgeWaiters } from "./runtime";
import {
    effectiveState,
    forgetTeamSession,
    isTeamStopped,
    listTeam,
    markTeamStopped,
    postTeamMessages,
    readBoard,
    sessionTitle,
    teamCost,
    teamOf,
    type MemberState,
    type TeamRole,
} from "./store";
import { moveMember } from "./tools";

export * from "./store";
export * from "./runtime";
export * from "./prompts";
export * from "./budget";
export * from "./turn-end";
export { createTeamTools, maxTeamThreads, moveMember, DEFAULT_MAX_THREADS, type TeamToolContext } from "./tools";

/** The `threadTeams` setting. Off unless turned on. */
export function isThreadTeamsEnabled(): boolean {
    return getSetting("threadTeams") === true;
}

export interface TeamSnapshotMember {
    readonly id: string;
    readonly title: string;
    readonly role: TeamRole;
    readonly state: MemberState;
    readonly activity?: string;
    /** A turn is running in it right now (in this process). */
    readonly running: boolean;
    /** Everything billed to this thread. */
    readonly usd: number;
    /** Of `usd`, what turns the team started cost — the rest came from the user typing into it. */
    readonly teamUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
}

/** A team as every client's panel draws it (RPC `team.get`). */
export interface TeamSnapshot {
    readonly teamId: string;
    readonly stopped: boolean;
    /** Stopped, and over its budget: why it stopped, for the panels to say. */
    readonly overBudget: boolean;
    readonly lead: TeamSnapshotMember;
    readonly members: readonly TeamSnapshotMember[];
    readonly board: ReadonlyArray<{ key: string; body: string; from: { id: string; title: string }; ts: number }>;
    readonly cost: {
        readonly usd: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly estimated: boolean;
    };
}

export function teamSnapshot(teamId: string): TeamSnapshot | null {
    const roster = listTeam(teamId);
    const leadRow = roster.find((m) => m.role === "lead");
    if (!leadRow) return null;
    const cost = teamCost(teamId);
    const runtime = getTeamRuntime();
    const view = (m: (typeof roster)[number]): TeamSnapshotMember => {
        const share = cost.bySession.get(m.sessionId);
        const running = (runtime?.isRunning(m.sessionId) ?? false) || isTurnActive(m.sessionId);
        // A turn here keeps its row alive with a heartbeat, so only a row
        // nothing anywhere is running goes stale.
        const state = running ? m.state : effectiveState(m);
        const stale = state !== m.state;
        return {
            id: m.sessionId,
            title: m.role === "lead" ? sessionTitle(m.sessionId) : m.title,
            role: m.role,
            state,
            ...(m.activity && !stale ? { activity: m.activity } : {}),
            running,
            usd: share?.usd ?? 0,
            teamUsd: share?.teamUsd ?? 0,
            inputTokens: share?.inputTokens ?? 0,
            outputTokens: share?.outputTokens ?? 0,
        };
    };
    const stopped = isTeamStopped(teamId);
    return {
        teamId,
        stopped,
        overBudget: stopped && isTeamOverBudget(teamId),
        lead: view(leadRow),
        members: roster.filter((m) => m.role === "member").map(view),
        board: readBoard(teamId).map((n) => ({
            key: n.key,
            body: n.body,
            from: { id: n.from, title: sessionTitle(n.from) },
            ts: n.ts,
        })),
        cost: {
            usd: cost.usd,
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
            estimated: cost.estimated,
        },
    };
}

/** The team a session is in, as a snapshot — the lead's or any member's id works. */
export function teamSnapshotForSession(sessionId: string): TeamSnapshot | null {
    const team = teamOf(sessionId);
    return team ? teamSnapshot(team.teamId) : null;
}

/**
 * Stop every thread: each is marked stopped, its turn cancelled and its
 * background shells killed, and no mail starts a new turn until the lead spawns
 * again. Marked first, so a cancelled turn ending finds "stopped" and leaves it
 * — not "idle", which would read as a thread that could still be woken.
 *
 * The lead is not a thread: its turn carries on. It is the one left to finish
 * the job, and what the user is talking to.
 */
function haltThreads(teamId: string): void {
    markTeamStopped(teamId, true);
    const threads = listTeam(teamId).filter((m) => m.role === "member");
    for (const m of threads) moveMember(m.sessionId, "stopped", null);
    const runtime = getTeamRuntime();
    for (const m of threads) {
        if (runtime?.isRunning(m.sessionId)) runtime.cancel(m.sessionId);
        killSessionShells(m.sessionId);
    }
    // A lead inside wait_for_team returns now, with the stop, instead of at its timeout.
    nudgeWaiters();
}

export type TeamStopReason = "user" | "budget";

const STOP_NOTICES: Record<TeamStopReason, string> = {
    user: "The user stopped the team: every thread was cancelled. Do not restart them unless the user asks.",
    budget: "The team reached its budget (threadTeamsBudgetUsd) and was stopped: every thread was cancelled. Finish the job yourself, or ask the user to raise the budget.",
};

/**
 * Stop a whole team and tell its lead why. The note waits in the lead's inbox:
 * a running lead reads it before its next step, an idle one on its next turn —
 * a stop never starts a turn of its own.
 */
export function stopTeam(teamId: string, reason: TeamStopReason = "user"): void {
    const alreadyStopped = isTeamStopped(teamId);
    const lead = listTeam(teamId).find((m) => m.role === "lead");
    if (lead && !alreadyStopped) {
        postTeamMessages({
            teamId,
            from: lead.sessionId,
            to: [lead.sessionId],
            kind: "update",
            body: STOP_NOTICES[reason],
        });
    }
    haltThreads(teamId);
    if (reason === "budget") emitTeamChange({ teamId, kind: "budget" });
}

/**
 * A session is being deleted: it leaves its team. A lead's team goes with it,
 * so its threads are stopped first — nobody would be left to read their reports.
 */
export function leaveTeam(sessionId: string): void {
    const team = teamOf(sessionId);
    if (!team) return;
    if (team.role === "lead") haltThreads(team.teamId);
    forgetTeamSession(sessionId);
    emitTeamChange({ teamId: team.teamId, kind: "members", sessionId });
    nudgeWaiters();
}

// The budget: checked on every bill to a team member, so a team stops within
// one step of crossing it.
onLedgerRow((sessionPub) => {
    if (teamBudgetUsd() === null) return;
    const team = teamOf(sessionPub);
    if (!team || isTeamStopped(team.teamId)) return;
    if (isTeamOverBudget(team.teamId)) stopTeam(team.teamId, "budget");
});
