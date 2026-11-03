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
 */
import { getSetting } from "../settings";
import { onLedgerRow } from "../sessions/cost-ledger";
import { isTeamOverBudget, teamBudgetUsd } from "./budget";
import { emitTeamChange, getTeamRuntime, isTurnActive, nudgeWaiters } from "./runtime";
import {
    effectiveState,
    forgetTeamSession,
    isTeamStopped,
    listTeam,
    markTeamStopped,
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
    return {
        teamId,
        stopped: isTeamStopped(teamId),
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
 * Stop a whole team: the members are marked stopped, every running turn in it
 * is cancelled, and no mail starts a new turn until the lead spawns again.
 * Marked first, so a cancelled turn ending finds "stopped" and leaves it — not
 * "idle", which would read as a thread that could still be woken.
 */
export function stopTeam(teamId: string): void {
    markTeamStopped(teamId, true);
    const roster = listTeam(teamId);
    for (const m of roster) if (m.role === "member") moveMember(m.sessionId, "stopped", null);
    const runtime = getTeamRuntime();
    for (const m of roster) if (runtime?.isRunning(m.sessionId)) runtime.cancel(m.sessionId);
    // A lead inside wait_for_team returns now, with the stop, instead of at its timeout.
    nudgeWaiters();
}

/**
 * A session is being deleted: it leaves its team. A lead's team goes with it,
 * so its threads are stopped first — nobody would be left to read their reports.
 */
export function leaveTeam(sessionId: string): void {
    const team = teamOf(sessionId);
    if (!team) return;
    if (team.role === "lead") stopTeam(team.teamId);
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
    if (isTeamOverBudget(team.teamId)) stopTeam(team.teamId);
});
