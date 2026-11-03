/**
 * The thread-team tools: spawn_threads (the lead's), send_message,
 * team_board, wait_for_team, and report (a member's).
 *
 * Attached in runTurn only while the `threadTeams` setting is on, and only for
 * unrestricted agents. A member gets every tool but spawn_threads, so a team
 * is one level deep.
 */
import { tool } from "ai";
import { z } from "zod";
import { agentExists, getAgentTools } from "../agent/agents";
import type { ThinkingLevel } from "../agent/thinking";
import { getSetting } from "../settings";
import { parseModelId } from "../providers";
import { SessionManager, type Session } from "../sessions";
import type { ProviderId } from "../types";
import {
    REPORT_TOOL,
    SEND_MESSAGE_TOOL,
    SPAWN_THREADS_TOOL,
    TEAM_BOARD_TOOL,
    WAIT_FOR_TEAM_TOOL,
    memberOpeningMessage,
} from "./prompts";
import { isTeamOverBudget } from "./budget";
import {
    addWaiter,
    deliverTeamTurn,
    emitTeamChange,
    formatMailForModel,
    getTeamRuntime,
    mailViews,
    markWaiting,
    nudgeWaiters,
    wakeTeamInbox,
    type TeamMailView,
} from "./runtime";
import {
    FINISHED_STATES,
    addTeamMember,
    createTeam,
    effectiveState,
    forgetTeamSession,
    isTeamStopped,
    listTeam,
    markTeamStopped,
    postBoardNote,
    postTeamMessages,
    readBoard,
    removeTeam,
    sessionTitle,
    setMemberRunConfig,
    setMemberState,
    takeInbox,
    teamOf,
    type MemberState,
    type TeamMemberRow,
} from "./store";

export const DEFAULT_MAX_THREADS = 5;
const MAX_TITLE_CHARS = 48;
const DEFAULT_WAIT_SEC = 600;
const MAX_WAIT_SEC = 3600;

export function maxTeamThreads(): number {
    const configured = getSetting("threadTeamsMaxThreads");
    return typeof configured === "number" && configured > 0
        ? Math.min(20, Math.floor(configured))
        : DEFAULT_MAX_THREADS;
}

export interface TeamToolContext {
    session: Session;
    modelId: string;
    cwd: string;
    /** The lead's thinking level — the threads it starts run at the same one. */
    thinkingLevel?: ThinkingLevel;
    abortSignal?: AbortSignal;
}

/** A member moved state: tell the panels, and anyone waiting on the team. */
export function moveMember(sessionId: string, state: MemberState, activity?: string | null): void {
    const team = teamOf(sessionId);
    if (!team) return;
    if (setMemberState(sessionId, state, activity)) {
        emitTeamChange({ teamId: team.teamId, kind: "members", sessionId });
        nudgeWaiters();
    }
}

function rosterText(roster: readonly TeamMemberRow[], selfId: string): string {
    return roster
        .map(
            (m) =>
                `- "${m.title}" — ${m.role === "lead" ? "lead" : effectiveState(m)} — id ${m.sessionId}${m.sessionId === selfId ? " (you)" : ""}`,
        )
        .join("\n");
}

function clipTitle(title: string): string {
    const one = title.replace(/\s+/g, " ").trim();
    return one.length > MAX_TITLE_CHARS ? `${one.slice(0, MAX_TITLE_CHARS - 1)}…` : one;
}

/** A thread spawn_threads has checked and is about to create. */
interface ThreadPlan {
    readonly title: string;
    readonly brief: string;
    readonly model: string;
    readonly provider: ProviderId;
    readonly agent?: string;
}

interface CreatedThread {
    readonly session: Session;
    readonly title: string;
    readonly brief: string;
    readonly agent?: string;
}

type ThreadRequest = { title: string; brief: string; model?: string; agent?: string };

/**
 * Every thread checked before any is created — a bad model or agent on the
 * third must not leave the first two running. Returns the plans, or why not.
 */
function planThreads(threads: readonly ThreadRequest[], defaultModel: string): ThreadPlan[] | string {
    const plans: ThreadPlan[] = [];
    for (const t of threads) {
        if (!t.title.trim()) return "REJECTED: every thread needs a title.";
        if (!t.brief.trim()) return `REJECTED: "${t.title}" has no brief. Resend it with what the thread should do.`;
        const model = t.model?.trim() || defaultModel;
        let provider: ProviderId;
        try {
            provider = parseModelId(model).provider as ProviderId;
        } catch {
            return `REJECTED: "${model}" is not a provider/model id.`;
        }
        const agent = t.agent?.trim() || undefined;
        if (agent && !agentExists(agent)) return `REJECTED: there is no agent named "${agent}".`;
        // A restricted agent gets no team tools (agent/turn.ts), so it could
        // never report back and its lead would wait on it for good.
        if (agent && getAgentTools(agent)?.length) {
            return `REJECTED: the "${agent}" agent has a restricted tool set, so it cannot ${REPORT_TOOL} to you. Run that thread as an unrestricted agent.`;
        }
        plans.push({ title: clipTitle(t.title), brief: t.brief, model, provider, ...(agent ? { agent } : {}) });
    }
    return plans;
}

/** Threads WORKING right now. Finished ones stay in the team for good and never count against the cap. */
function workingThreads(teamId: string): number {
    return listTeam(teamId).filter((m) => m.role === "member" && !FINISHED_STATES.has(effectiveState(m))).length;
}

/**
 * Create every planned thread in the team, or none: a failure partway deletes
 * the ones already made (and the team, if this call made it).
 */
async function createThreads(
    teamId: string,
    teamIsNew: boolean,
    plans: readonly ThreadPlan[],
    ctx: TeamToolContext,
): Promise<CreatedThread[]> {
    const manager = new SessionManager();
    const created: CreatedThread[] = [];
    try {
        for (const [index, plan] of plans.entries()) {
            // A millisecond apart: ids made in the same one differ only in
            // their random tail, and a model told to address threads by id
            // confuses ids that look alike. Apart, they still sort in the
            // order the lead started them.
            if (index > 0) await new Promise((resolve) => setTimeout(resolve, 2));
            const session = await manager.create({ cwd: ctx.cwd, provider: plan.provider, model: plan.model });
            created.push({
                session,
                title: plan.title,
                brief: plan.brief,
                ...(plan.agent ? { agent: plan.agent } : {}),
            });
            // Named by the lead, so the member never spends a model call
            // titling itself (session-title.ts leaves a set name alone).
            await session.setName(plan.title);
            addTeamMember(teamId, session.id, "starting");
            // Every later turn runs as this one does, whichever host picks it up.
            setMemberRunConfig(session.id, {
                ...(plan.agent ? { agent: plan.agent } : {}),
                ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
            });
        }
    } catch (err) {
        for (const c of created) {
            forgetTeamSession(c.session.id);
            manager.delete(c.session.id);
        }
        if (teamIsNew) removeTeam(teamId);
        throw err;
    }
    return created;
}

/**
 * Every earlier member hears who joined — the roster is not in the system
 * prompt (see prompts.ts), so this mail is how they learn. Only those still
 * at work are woken for it: a new turn just to read the news would cost a
 * finished one a model call, so theirs waits in the inbox and arrives with
 * whatever wakes them next. Returns the earlier members.
 */
function announceNewcomers(teamId: string, leadId: string, created: readonly CreatedThread[]): TeamMemberRow[] {
    const earlier = listTeam(teamId).filter(
        (m) => m.role === "member" && !created.some((c) => c.session.id === m.sessionId),
    );
    if (earlier.length === 0) return earlier;
    const joined = created.map((c) => `"${c.title}" (id ${c.session.id})`).join(", ");
    postTeamMessages({
        teamId,
        from: leadId,
        to: earlier.map((m) => m.sessionId),
        kind: "update",
        body: `New in the team: ${joined}.`,
    });
    return earlier;
}

/** Hand each new thread its brief. One that will not start is marked failed, so nobody waits on it. */
async function startThreads(teamId: string, leadId: string, created: readonly CreatedThread[]): Promise<string[]> {
    const leadTitle = sessionTitle(leadId);
    const roster = listTeam(teamId);
    const failed: string[] = [];
    for (const c of created) {
        const opening = memberOpeningMessage({
            leadTitle,
            title: c.title,
            brief: c.brief,
            roster,
            selfId: c.session.id,
        });
        try {
            await deliverTeamTurn(c.session.id, opening, {
                kind: "spawn",
                teamId,
                from: { id: leadId, title: leadTitle },
                title: c.title,
                ...(c.agent ? { agent: c.agent } : {}),
            });
        } catch {
            moveMember(c.session.id, "failed", null);
            failed.push(c.title);
        }
    }
    return failed;
}

function spawnResult(
    teamId: string,
    created: readonly CreatedThread[],
    earlier: readonly TeamMemberRow[],
    failed: readonly string[],
): string {
    const alsoInTeam =
        earlier.length > 0
            ? `\n\nAlso in your team (finished threads keep their context; message one with ${SEND_MESSAGE_TOOL} to give it more work):\n` +
              earlier.map((m) => `- "${m.title}" — ${effectiveState(m)} — id ${m.sessionId}`).join("\n")
            : "";
    const notStarted =
        failed.length > 0
            ? `\n\nThese could not be started and are marked failed: ${failed.map((t) => `"${t}"`).join(", ")}.`
            : "";
    return (
        `Started ${created.length} thread${created.length === 1 ? "" : "s"} (team ${teamId}):\n` +
        created.map((c) => `- "${c.title}" — id ${c.session.id}`).join("\n") +
        alsoInTeam +
        notStarted +
        `\n\nThey are working in the background. Their messages and reports reach you on their own. Call ${WAIT_FOR_TEAM_TOOL} only when your next step needs their results; otherwise keep working or end your turn.`
    );
}

/**
 * One spawn at a time per lead. Two spawn_threads calls in one step run side
 * by side, and both would count the same working threads against the cap.
 */
const spawnLocks = new Map<string, Promise<unknown>>();

async function underLeadLock<T>(leadId: string, fn: () => Promise<T>): Promise<T> {
    const run = (spawnLocks.get(leadId) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    spawnLocks.set(leadId, settled);
    try {
        return await run;
    } finally {
        if (spawnLocks.get(leadId) === settled) spawnLocks.delete(leadId);
    }
}

async function spawnThreads(threads: readonly ThreadRequest[], ctx: TeamToolContext, max: number): Promise<string> {
    const self = ctx.session.id;
    if (!getTeamRuntime()) return "REJECTED: thread teams are not available in this process.";
    const existing = teamOf(self);
    if (existing && existing.role === "member") {
        return "REJECTED: you are a thread in a team; only the lead starts threads. Ask the lead with send_message if the work needs another thread.";
    }
    const active = existing ? workingThreads(existing.teamId) : 0;
    if (active + threads.length > max) {
        return `REJECTED: at most ${max} threads can work at once; ${active} are still working and you asked for ${threads.length} more. Start fewer, wait for some to finish, or give the work to a finished thread with ${SEND_MESSAGE_TOOL}.`;
    }
    const plans = planThreads(threads, ctx.modelId);
    if (typeof plans === "string") return plans;
    if (existing && isTeamStopped(existing.teamId) && isTeamOverBudget(existing.teamId)) {
        return "REJECTED: the team was stopped because it reached its budget (threadTeamsBudgetUsd). Finish the job yourself, or ask the user to raise the budget.";
    }

    const teamId = existing?.teamId ?? createTeam(self);
    const created = await createThreads(teamId, !existing, plans, ctx);
    if (existing && isTeamStopped(teamId)) markTeamStopped(teamId, false);
    emitTeamChange({ teamId, kind: "members" });

    const earlier = announceNewcomers(teamId, self, created);
    const failed = await startThreads(teamId, self, created);
    for (const v of earlier) if (!FINISHED_STATES.has(effectiveState(v))) wakeTeamInbox(v.sessionId);
    return spawnResult(teamId, created, earlier, failed);
}

export function createSpawnThreadsTool(ctx: TeamToolContext) {
    const max = maxTeamThreads();
    return tool({
        description:
            `Start threads that work in parallel on parts of the job — a team you lead. Each thread is a full session with its own context and tools, in this same folder. Returns at once with each thread's id; the threads run in the background, and their messages and reports reach you on their own. Up to ${max} threads can work at once; calling it again adds threads to the same team. Threads that finished stay in the team with their context — to give one more work, message it with send_message instead of starting a new thread.\n\n` +
            "Give each thread a short title (its name in every list, max 48 characters) and a brief it can act on alone: the goal, the files it owns, the contract to keep, how to verify.",
        inputSchema: z.object({
            threads: z
                .array(
                    z.object({
                        title: z.string().describe("Short name for the thread, e.g. 'CSV export endpoint'."),
                        brief: z
                            .string()
                            .describe("The thread's full first message: what to do and how to know it is done."),
                        model: z
                            .string()
                            .optional()
                            .describe("provider/model to run it on. Omit to use the same model as you."),
                        agent: z
                            .string()
                            .optional()
                            .describe("A named agent to run it as. Omit for the default agent."),
                    }),
                )
                .min(1)
                .describe("The threads to start."),
        }),
        execute: ({ threads }) => underLeadLock(ctx.session.id, () => spawnThreads(threads, ctx, max)),
    });
}

export function createSendMessageTool(ctx: TeamToolContext) {
    return tool({
        description:
            'Send a message to a thread in your team, by its thread id, or to every thread with "all". Returns at once — it does not wait for a reply. To wait for the answer, call wait_for_team with until "any".',
        inputSchema: z.object({
            to: z.string().describe('The receiving thread\'s id (from the team list), or "all".'),
            message: z.string().describe("What to say. Be specific; the receiver sees only this."),
        }),
        execute: async ({ to, message }) => {
            const self = ctx.session.id;
            const team = teamOf(self);
            if (!team) return `REJECTED: there is no team yet — start one with ${SPAWN_THREADS_TOOL}.`;
            if (!message.trim()) return "REJECTED: the message is empty.";
            const roster = listTeam(team.teamId);
            const others = roster.filter((m) => m.sessionId !== self);
            const target = to.trim();
            const recipients = target === "all" ? others : others.filter((m) => m.sessionId === target);
            if (recipients.length === 0) {
                return `REJECTED: no thread in this team has id "${target}". The team:\n${rosterText(roster, self)}`;
            }
            postTeamMessages({
                teamId: team.teamId,
                from: self,
                to: recipients.map((r) => r.sessionId),
                kind: "message",
                body: message,
            });
            for (const r of recipients) wakeTeamInbox(r.sessionId);
            const sent =
                target === "all" ? `Sent to all ${recipients.length} threads.` : `Sent to "${recipients[0]!.title}".`;
            // Mail to a stopped team waits; without saying so the sender
            // would wait on an answer that is not coming.
            return isTeamStopped(team.teamId)
                ? `${sent} The team is stopped, so nobody will read it until the lead starts threads again.`
                : sent;
        },
    });
}

export function createTeamBoardTool(ctx: TeamToolContext) {
    return tool({
        description:
            "The team's shared notes. post adds or replaces the note under a key (an empty content removes it); read returns every note, or one key. Use it for facts the whole team needs: an API contract, decisions, who owns which files.",
        inputSchema: z.object({
            action: z.enum(["read", "post"]),
            key: z.string().optional().describe("The note's name, e.g. 'api-contract'. Required to post."),
            content: z.string().optional().describe("The note. Required to post."),
        }),
        execute: async ({ action, key, content }) => {
            const self = ctx.session.id;
            // A lead's board note before its first spawn — often in the same
            // step as the spawn — starts the team rather than bouncing.
            let team = teamOf(self);
            if (!team && action === "post") {
                createTeam(self);
                team = teamOf(self);
            }
            if (!team) return `REJECTED: there is no team yet — start one with ${SPAWN_THREADS_TOOL}.`;
            if (action === "post") {
                const k = key?.trim();
                if (!k) return "REJECTED: posting needs a key.";
                if (content === undefined) return "REJECTED: posting needs content (an empty string removes the note).";
                postBoardNote(team.teamId, self, k, content);
                emitTeamChange({ teamId: team.teamId, kind: "board", sessionId: self });
                return content.trim() === "" ? `Removed "${k}" from the board.` : `Posted "${k}" to the board.`;
            }
            const notes = readBoard(team.teamId).filter((n) => !key || n.key === key.trim());
            if (notes.length === 0) return key ? `The board has no note "${key}".` : "The board is empty.";
            return notes.map((n) => `## ${n.key}\n(by "${sessionTitle(n.from)}")\n${n.body}`).join("\n\n");
        },
    });
}

export function createWaitForTeamTool(ctx: TeamToolContext) {
    return tool({
        description:
            "Pause your turn, at no cost, until the team has something for you, then return what happened. Use it only when your next step needs the threads' results.\n\n" +
            'until: "all" (default) returns once every thread has finished — or earlier if a thread sends you a message, so you can answer it; reports are collected along the way. "any" returns at the next message, report or finished thread. A list of thread ids returns once those have finished. Returns at timeoutSec (default 600) with each thread\'s state either way.',
        inputSchema: z.object({
            until: z
                .union([z.enum(["all", "any"]), z.array(z.string())])
                .optional()
                .describe('"all", "any", or a list of thread ids.'),
            timeoutSec: z.number().optional().describe("Give up after this many seconds (default 600, max 3600)."),
        }),
        execute: async ({ until, timeoutSec }) => {
            const self = ctx.session.id;
            const team = teamOf(self);
            if (!team) return `REJECTED: there is no team yet — start one with ${SPAWN_THREADS_TOOL}.`;
            const mode = until ?? "all";
            const roster0 = listTeam(team.teamId);
            const targetIds = Array.isArray(mode)
                ? mode.map((id) => id.trim()).filter(Boolean)
                : roster0.filter((m) => m.role === "member" && m.sessionId !== self).map((m) => m.sessionId);
            const unknown = targetIds.filter((id) => !roster0.some((m) => m.sessionId === id));
            if (unknown.length > 0) {
                return `REJECTED: not in this team: ${unknown.join(", ")}. The team:\n${rosterText(roster0, self)}`;
            }
            const timeoutMs = Math.min(MAX_WAIT_SEC, Math.max(5, timeoutSec ?? DEFAULT_WAIT_SEC)) * 1000;
            const startedAt = Date.now();
            const collected: TeamMailView[] = [];
            const startState = new Map(roster0.map((m) => [m.sessionId, effectiveState(m)]));

            moveMember(self, "waiting", null);
            markWaiting(self, true);
            let outcome: "done" | "message" | "changed" | "timeout" | "aborted" = "timeout";
            try {
                for (;;) {
                    collected.push(...mailViews(takeInbox(self)));
                    const roster = listTeam(team.teamId);
                    const finished = (id: string) => {
                        const m = roster.find((r) => r.sessionId === id);
                        return !m || FINISHED_STATES.has(effectiveState(m));
                    };
                    if (mode === "any") {
                        // "Someone joined" is news, not something to answer —
                        // it rides along with whatever does end the wait.
                        if (collected.some((m) => m.kind !== "update")) {
                            outcome = "message";
                            break;
                        }
                        const moved = roster.some(
                            (m) =>
                                m.sessionId !== self &&
                                FINISHED_STATES.has(effectiveState(m)) &&
                                startState.get(m.sessionId) !== effectiveState(m),
                        );
                        if (moved) {
                            outcome = "changed";
                            break;
                        }
                    } else {
                        if (collected.some((m) => m.kind === "message")) {
                            outcome = "message";
                            break;
                        }
                        if (targetIds.every(finished)) {
                            outcome = "done";
                            break;
                        }
                    }
                    if (ctx.abortSignal?.aborted) {
                        outcome = "aborted";
                        break;
                    }
                    const left = timeoutMs - (Date.now() - startedAt);
                    if (left <= 0) {
                        outcome = "timeout";
                        break;
                    }
                    await new Promise<void>((resolve) => {
                        let settled = false;
                        const finish = () => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(timer);
                            stop();
                            ctx.abortSignal?.removeEventListener("abort", finish);
                            resolve();
                        };
                        // A slow tick as a safety net for a change nobody announced.
                        const timer = setTimeout(finish, Math.min(left, 5000));
                        const stop = addWaiter(self, finish);
                        ctx.abortSignal?.addEventListener("abort", finish, { once: true });
                    });
                }
            } finally {
                markWaiting(self, false);
                moveMember(self, ctx.abortSignal?.aborted ? "idle" : "running", null);
            }

            const roster = listTeam(team.teamId);
            const states = roster
                .filter((m) => m.sessionId !== self && m.role === "member")
                .map(
                    (m) =>
                        `- "${m.title}" (id ${m.sessionId}): ${effectiveState(m)}${m.activity ? ` — ${m.activity}` : ""}`,
                )
                .join("\n");
            const head =
                outcome === "done"
                    ? "Every thread has finished."
                    : outcome === "message"
                      ? "A teammate sent you a message."
                      : outcome === "changed"
                        ? "A thread finished."
                        : outcome === "aborted"
                          ? "Stopped waiting: the turn was cancelled."
                          : `Stopped waiting after ${Math.round((Date.now() - startedAt) / 1000)}s; the team is still working.`;
            return `${head}\n\nThreads:\n${states || "(none)"}${collected.length > 0 ? `\n\n${formatMailForModel(collected)}` : ""}`;
        },
    });
}

export function createReportTool(ctx: TeamToolContext) {
    return tool({
        description:
            "Finish your job in the team: report to the lead what you did, the files you changed, and anything left open. Call it once, at the end. Your turn ends after it.",
        inputSchema: z.object({
            summary: z.string().describe("What you did and the outcome, including how you verified it."),
            files: z.array(z.string()).optional().describe("Files you created or changed."),
            open: z.string().optional().describe("Anything unfinished, blocked, or that the lead should decide."),
        }),
        execute: async ({ summary, files, open }) => {
            const self = ctx.session.id;
            const team = teamOf(self);
            if (!team) return `REJECTED: there is no team yet — start one with ${SPAWN_THREADS_TOOL}.`;
            if (team.role === "lead") {
                return "REJECTED: report is how a thread answers its lead; you are the lead. Answer the user directly.";
            }
            const body = [
                summary.trim(),
                files && files.length > 0 ? `Files: ${files.join(", ")}` : "",
                open?.trim() ? `Open: ${open.trim()}` : "",
            ]
                .filter(Boolean)
                .join("\n\n");
            postTeamMessages({ teamId: team.teamId, from: self, to: [team.leadId], kind: "report", body });
            moveMember(self, "done", null);
            wakeTeamInbox(team.leadId);
            return "Reported to the lead. Your job is done — end your turn now.";
        },
    });
}

/** The tools a session gets for this turn: everything for a lead, all but spawn_threads for a member. */
export function createTeamTools(ctx: TeamToolContext): Record<string, unknown> {
    const team = teamOf(ctx.session.id);
    const isMember = team?.role === "member";
    // A lead gets the whole set from the start, team or not: the toolset is
    // fixed for a turn, and the turn that spawns the threads is the one most
    // likely to post the contract and wait for them.
    return {
        ...(isMember ? {} : { [SPAWN_THREADS_TOOL]: createSpawnThreadsTool(ctx) }),
        [SEND_MESSAGE_TOOL]: createSendMessageTool(ctx),
        [TEAM_BOARD_TOOL]: createTeamBoardTool(ctx),
        [WAIT_FOR_TEAM_TOOL]: createWaitForTeamTool(ctx),
        ...(isMember ? { [REPORT_TOOL]: createReportTool(ctx) } : {}),
    };
}
