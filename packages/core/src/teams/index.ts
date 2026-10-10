/**
 * Thread teams: an agent splits a job across threads that run in parallel,
 * know about each other, message each other, and report back to the thread
 * that started them. Behind the `threadTeams` setting, off by default.
 *
 *   store.ts    who is in which team, their states, the mail (SQLite)
 *   runtime.ts  who runs a member's turns, delivery, change notices
 *   tools.ts    spawn_threads, send_message, team_board, wait_for_team, report
 *   prompts.ts  what the model is told
 */
import { getSetting } from "../settings";
import { onLedgerRow } from "../sessions/cost-ledger";
import { getTeamRuntime, isTurnActive } from "./runtime";
import {
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

const BUSY_STATES: ReadonlySet<MemberState> = new Set(["running", "starting", "waiting"]);
/** How long a busy row may sit unchanged, with nothing here running it, before it reads idle. */
const STALE_MS = 10 * 60_000;

export function teamSnapshot(teamId: string): TeamSnapshot | null {
    const roster = listTeam(teamId);
    const leadRow = roster.find((m) => m.role === "lead");
    if (!leadRow) return null;
    const cost = teamCost(teamId);
    const runtime = getTeamRuntime();
    const view = (m: (typeof roster)[number]): TeamSnapshotMember => {
        const share = cost.bySession.get(m.sessionId);
        const running = (runtime?.isRunning(m.sessionId) ?? false) || isTurnActive(m.sessionId);
        // A process that quit mid-team leaves its threads "running" on disk
        // for good. Nothing here runs it and it has not moved in a while: it
        // stopped, whatever the row says. (Another process may be running a
        // long tool call — it reads idle until its next move.)
        const stale = !running && BUSY_STATES.has(m.state) && Date.now() - m.updatedAt > STALE_MS;
        return {
            id: m.sessionId,
            title: m.role === "lead" ? sessionTitle(m.sessionId) : m.title,
            role: m.role,
            state: stale ? "idle" : m.state,
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
 * Stop a whole team: every running turn in it is cancelled, the members are
 * marked stopped, and no mail starts a new turn until the lead spawns again.
 */
export function stopTeam(teamId: string): void {
    markTeamStopped(teamId, true);
    const runtime = getTeamRuntime();
    for (const m of listTeam(teamId)) {
        if (runtime?.isRunning(m.sessionId)) runtime.cancel(m.sessionId);
        if (m.role === "member") moveMember(m.sessionId, "stopped", null);
    }
}

// The budget (threadTeamsBudgetUsd): checked on every bill to a team member,
// so a team stops within one step of crossing it.
onLedgerRow((sessionPub) => {
    const budget = getSetting("threadTeamsBudgetUsd");
    if (typeof budget !== "number" || budget <= 0) return;
    const team = teamOf(sessionPub);
    if (!team || isTeamStopped(team.teamId)) return;
    if (teamCost(team.teamId).usd >= budget) stopTeam(team.teamId);
});
