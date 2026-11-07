/**
 * What happens in a team when a turn ends: the panels hear the state it left
 * behind, and a lead whose thread stopped without reporting is told so. It would
 * otherwise wait for a report that is never coming.
 */
import { wakeTeamInbox, type TeamTurnMeta } from "./runtime";
import { hasMailedSince, postTeamMessages, setMemberActivity, type TeamMembership } from "./store";
import { moveMember } from "./tools";

/** Enough of an error for the lead to act on; the thread's transcript has the rest. */
const MAX_FAILURE_CHARS = 500;

export interface TeamTurnEnd {
    readonly startedAt: number;
    readonly aborted: boolean;
    /** The error the turn ended on, or null. */
    readonly failure: string | null;
    /** Why the team started this turn; absent when the user typed it. */
    readonly team?: TeamTurnMeta;
}

/** A report already said "done", and a stopped thread stays stopped: both are final. */
export function settleTeamTurn(membership: TeamMembership, end: TeamTurnEnd): void {
    const { sessionId, state, role } = membership;
    if (state === "done" || state === "stopped") {
        if (membership.activity) setMemberActivity(sessionId, null);
        return;
    }
    moveMember(sessionId, end.failure !== null && !end.aborted ? "failed" : "idle", null);
    if (role === "member") tellLeadHowItEnded(membership, end);
}

/** The lead gave this turn its work: the brief, or a message of its own. A turn a teammate or the user started is theirs to follow. */
function owesLeadAnAnswer(membership: TeamMembership, turn: TeamTurnMeta | undefined): boolean {
    return turn?.kind === "spawn" || turn?.mail?.some((m) => m.from.id === membership.leadId) === true;
}

function howItEnded(end: TeamTurnEnd): string {
    if (end.aborted) return "This thread was cancelled before it reported.";
    if (end.failure !== null) {
        return `This thread failed before it reported: ${end.failure.slice(0, MAX_FAILURE_CHARS)}`;
    }
    return "This thread ended its turn without a report. Message it to ask what happened.";
}

function tellLeadHowItEnded(membership: TeamMembership, end: TeamTurnEnd): void {
    const { sessionId, teamId, leadId } = membership;
    if (!owesLeadAnAnswer(membership, end.team)) return;
    // Answering the lead with send_message is an answer, if the turn then ended cleanly.
    const clean = end.failure === null && !end.aborted;
    if (clean && hasMailedSince(sessionId, leadId, end.startedAt)) return;
    postTeamMessages({ teamId, from: sessionId, to: [leadId], kind: "update", body: howItEnded(end) });
    wakeTeamInbox(leadId);
}
