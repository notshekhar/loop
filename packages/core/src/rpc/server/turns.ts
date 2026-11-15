import { runTurn } from "../../agent";
import { agentExists } from "../../agent/agents";
import { THINKING_LEVELS, type ThinkingLevel } from "../../agent/thinking";
import { runInSession } from "../../host/session-scope";
import { dropTeamTurn, mayRunTeamTurn, memberRunConfig, wakeTeamInbox, type TeamTurnMeta } from "../../teams";
import type { BtwMeta } from "../../types";
import { abortTurn, type ActiveSession } from "./active-session";
import { broadcast } from "./event-stream";
import type { SessionContexts } from "./session-contexts";

/** How one turn runs: its model and the per-turn choices that came with it. */
export interface TurnOptions {
    modelId: string;
    thinking?: ThinkingLevel;
    agent?: string;
    team?: TeamTurnMeta;
    btw?: BtwMeta;
}

/**
 * The per-turn choices a client may send with a prompt. Thinking: anything
 * unknown falls back to the thinkingLevel setting (runTurn's own default).
 * Agent: the RPC form of `/<agent> <message>` — this turn runs under that
 * agent's prompt and the session is untouched. An unknown name is refused
 * rather than silently falling back to the default persona, which would look
 * like the agent had simply ignored its instructions.
 */
export function turnChoices(params: Record<string, unknown>): { thinking?: ThinkingLevel; agent?: string } {
    const thinking = THINKING_LEVELS.includes(params.thinking as ThinkingLevel)
        ? (params.thinking as ThinkingLevel)
        : undefined;
    const agent = typeof params.agent === "string" ? params.agent.trim() : "";
    if (agent && !agentExists(agent)) throw new Error(`Unknown agent: ${agent}`);
    return { ...(thinking ? { thinking } : {}), ...(agent ? { agent } : {}) };
}

/** Runs the turns this server executes itself, including a thread team's. */
export class TurnRunner {
    constructor(private readonly contexts: SessionContexts) {}

    /** Stop a turn this server is running itself (Esc in the TUI following it). */
    cancelOwn(sessionId: string): void {
        const ctx = this.contexts.get(sessionId);
        if (ctx?.running) abortTurn(ctx);
    }

    /**
     * Run a team turn in a session this server holds (TeamRuntime.deliver).
     * Queued behind a turn already running there, which the team only does
     * in a race — mail to a busy thread normally waits in its inbox.
     */
    async deliverTeamTurn(sessionId: string, input: string, team: TeamTurnMeta): Promise<void> {
        const ctx = await this.contexts.ensureCtx(sessionId);
        if (ctx.running) {
            (ctx.pendingTeam ??= []).push({ input, team });
            return;
        }
        this.runTeamTurn(sessionId, ctx, input, team);
    }

    /**
     * Start a turn this server runs itself; events stream to every subscriber.
     * The turn's end is where a team thread picks up mail that arrived too
     * late for its last step.
     */
    start(id: string, ctx: ActiveSession, input: string, opts: TurnOptions): void {
        this.contexts.setRunning(id, ctx, true);
        // run async; events stream via notifications
        // Inside runInSession so the ask tool can tell which session
        // is asking — it follows the call through every await.
        void runInSession(id, () =>
            runTurn({
                session: ctx.session,
                modelId: opts.modelId,
                userInput: input,
                cwd: ctx.session.info.cwd,
                abortSignal: ctx.abort.signal,
                tracker: ctx.tracker,
                emitter: ctx.emitter,
                thinkingLevel: opts.thinking,
                ...(opts.agent ? { agent: opts.agent } : {}),
                ...(opts.team ? { team: opts.team } : {}),
                ...(opts.btw ? { btw: opts.btw } : {}),
            })
                .catch((err) => {
                    // Same channel + shape as the emitter's "error" event, so a
                    // client has one error path to handle, not two. Broadcast
                    // (not just the sender): every watcher needs the turn end.
                    broadcast(id, ctx, { type: "error", data: String(err) });
                })
                .finally(() => this.afterTurn(id, ctx)),
        );
    }

    /** The turn ended: run queued team mail, or wake the inbox for what came late. */
    private afterTurn(id: string, ctx: ActiveSession): void {
        this.contexts.setRunning(id, ctx, false);
        // A queued turn turned down (its team stopped) makes way for the next.
        for (let next = ctx.pendingTeam?.shift(); next; next = ctx.pendingTeam?.shift()) {
            this.runTeamTurn(id, ctx, next.input, next.team);
            if (ctx.running) return;
        }
        wakeTeamInbox(id);
    }

    /**
     * A team turn, run the way the lead started this thread — its agent and
     * thinking level, not whatever the last client chose. One whose team has
     * stopped since it was queued is turned down, its mail back in the inbox.
     */
    private runTeamTurn(id: string, ctx: ActiveSession, input: string, team: TeamTurnMeta): void {
        if (!mayRunTeamTurn(id)) {
            dropTeamTurn(team);
            return;
        }
        const run = memberRunConfig(id);
        const agent = run?.agent ?? team.agent;
        this.start(id, ctx, input, {
            modelId: ctx.modelId,
            team,
            ...(run?.thinkingLevel ? { thinking: run.thinkingLevel } : {}),
            ...(agent ? { agent } : {}),
        });
    }
}
