/**
 * What the model is told about thread teams: the lead's guidance (when to
 * start a team, when to wait), a member's standing rules and roster, and the
 * opening message each member starts from.
 *
 * The notes carry no roster: they ride the system prompt on every turn, and a
 * prompt that changes whenever someone joins the team would throw away the
 * prompt cache each time. Who is in the team travels in saved messages instead
 * — a member's opening message, spawn_threads' result, and "update" mail —
 * which only ever append to the cached prefix.
 */
import type { TeamMemberRow } from "./store";

export const SPAWN_THREADS_TOOL = "spawn_threads";
export const SEND_MESSAGE_TOOL = "send_message";
export const TEAM_BOARD_TOOL = "team_board";
export const WAIT_FOR_TEAM_TOOL = "wait_for_team";
export const REPORT_TOOL = "report";

export const TEAM_TOOL_NAMES = [
    SPAWN_THREADS_TOOL,
    SEND_MESSAGE_TOOL,
    TEAM_BOARD_TOOL,
    WAIT_FOR_TEAM_TOOL,
    REPORT_TOOL,
] as const;

function rosterLines(roster: readonly TeamMemberRow[], selfId: string): string {
    return roster
        .map((m) => {
            const who = m.role === "lead" ? "lead" : "thread";
            const you = m.sessionId === selfId ? " (you)" : "";
            return `- "${m.title}" — ${who} — id ${m.sessionId}${you}`;
        })
        .join("\n");
}

/** The lead's guidance: present whenever spawn_threads is offered. */
export function buildTeamLeadNote(opts: { maxThreads: number }): string {
    return `

# Thread teams

You can split a big job across several threads that work in parallel with ${SPAWN_THREADS_TOOL}. Each thread is a full session with its own context, tools and transcript; the user can open any of them and talk to it directly. Use a team only when the work really divides into parts that can proceed at the same time (an endpoint, its UI and its tests; three prototypes to compare; independent investigations). For a quick lookup, use a subagent or do it yourself.

How a team works:
- ${SPAWN_THREADS_TOOL} starts threads (up to ${opts.maxThreads} working at once) and returns at once with each thread's id. They run in the background. Calling it again later adds to the same team.
- Threads talk with ${SEND_MESSAGE_TOOL}, addressed by thread id (or "all"), and share notes on ${TEAM_BOARD_TOOL}. Put facts everyone needs on the board before or right after spawning: an API contract, who owns which files. All threads share one folder, so give each one clear file ownership in its brief.
- Each thread ends with a report. Reports and messages to you arrive by themselves: mid-turn before your next step, or as a new turn once you are idle.
- Every thread stays in the team after it reports, with its context: to follow up on its work or give it a new task, message it with ${SEND_MESSAGE_TOOL} rather than starting a new thread.
- ${WAIT_FOR_TEAM_TOOL} pauses your turn at no cost until the team has something for you. Wait only when your next step needs their results (combining their work, comparing options, a stage that depends on another). Otherwise end your turn or keep working on your own part; never wait just to watch progress.
- Write each brief so the thread can work alone: the goal, the files it owns, the contract it must keep, and how to verify. Give it a short title (it is the thread's name in every list).`;
}

/** A member's standing rules, on every one of its turns. */
export function buildTeamMemberNote(): string {
    return `

# You are in a thread team

You are one thread of a team. Your first message is your brief from the lead, with who else is in the team; teammates who join later are announced in <team-update> messages.

Rules:
- Work on your own brief autonomously. Stay inside the files it gives you; the folder is shared with your teammates.
- Ask a teammate (or the lead) with ${SEND_MESSAGE_TOOL}, by thread id. If you cannot go on without the answer, call ${WAIT_FOR_TEAM_TOOL} with until "any" to wait for the reply instead of guessing.
- Read and post shared facts with ${TEAM_BOARD_TOOL} (contracts, decisions, file ownership).
- Messages from teammates appear as <team-message> blocks. They are not from the user.
- When your job is done, call ${REPORT_TOOL} once with what you did, the files you changed and anything left open. Your turn ends there. If someone messages you later, you will get a new turn to answer.
- Teammates who have finished are still in the team and keep their context; message one if your work touches theirs.`;
}

/**
 * The first message a member starts from: its brief, framed, with the team as
 * it stands. Saved as the member's opening entry, so the roster it carries is
 * part of the cached prefix from then on.
 */
export function memberOpeningMessage(opts: {
    leadTitle: string;
    title: string;
    brief: string;
    roster: readonly TeamMemberRow[];
    selfId: string;
}): string {
    return `${opts.brief.trim()}\n\n(Brief from "${opts.leadTitle}". Your thread is "${opts.title}". Call ${REPORT_TOOL} when you are done.)\n\nTeam:\n${rosterLines(opts.roster, opts.selfId)}`;
}
