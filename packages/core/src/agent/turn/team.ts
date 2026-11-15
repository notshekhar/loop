/** What a turn does differently when its session is in a thread team (teams/). */
import type { ModelMessage } from "ai";
import {
    emitTeamChange,
    formatMailForModel,
    HEARTBEAT_MS,
    isWaiting,
    mailViews,
    REPORT_TOOL,
    setMemberActivity,
    takeInbox,
    teamOf,
    touchMember,
    WAIT_FOR_TEAM_TOOL,
    type TeamTurnMeta,
} from "../../teams";
import type { Session } from "../../sessions";
import type { Entry } from "../../types";
import type { TurnEmitter } from "../events";
import { subagentArgSummary } from "../subagent";
import type { StepPersister } from "./step-persistence";

/**
 * Keep this session's team row fresh while its turn runs, so a long tool call
 * or wait_for_team never reads as a thread left behind by a dead process
 * (teams/store.ts STALE_MS). Checked on every beat, not once: a lead's team
 * can start mid-turn. A no-op for a session in no team.
 */
export function startTeamHeartbeat(sessionId: string): () => void {
    const timer = setInterval(() => touchMember(sessionId), HEARTBEAT_MS);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
}

/**
 * The turn's emitter, watched on its way out without touching what anyone
 * hears: errors are reported to `onError`, and what the member is doing
 * follows its tool calls.
 */
export function teamWatchingEmitter(
    sessionId: string,
    inner: TurnEmitter,
    onError: (message: string) => void,
): TurnEmitter {
    const watch = (event: string, args: unknown[]) => {
        if (event === "error") onError(String(args[0]));
        else if (event === "tool-call") noteMemberActivity(sessionId, args[0]);
    };
    return new Proxy(inner, {
        get(target, prop) {
            if (prop === "emit") {
                return (event: string, ...args: unknown[]) => {
                    watch(event, args);
                    return (target.emit as (e: string, ...a: unknown[]) => boolean)(event, ...args);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as TurnEmitter;
}

function noteMemberActivity(sessionId: string, toolCall: unknown): void {
    const call = toolCall as { toolName?: string; input?: unknown } | undefined;
    if (!call?.toolName || call.toolName === WAIT_FOR_TEAM_TOOL) return;
    const team = teamOf(sessionId);
    // The stream can deliver a call after it already ran — a report that
    // finished the member must not come back as what it is "doing".
    const working = team?.state === "running" || team?.state === "starting";
    if (team && working && setMemberActivity(sessionId, `${call.toolName}${subagentArgSummary(call.input)}`)) {
        emitTeamChange({ teamId: team.teamId, kind: "activity", sessionId });
    }
}

/** Stop condition: the step just finished called `report`. */
export function reportedThisStep({
    steps,
}: {
    steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName?: string }> }>;
}): boolean {
    return steps.at(-1)?.toolCalls.some((c) => c.toolName === REPORT_TOOL) === true;
}

/**
 * Team mail that arrived mid-turn, as the message to add before the next
 * step, or null. Unlike a one-step notice it is saved as its own entry —
 * queued behind the step persistence, so it lands after the step that
 * preceded it — and a rebuilt attempt reads it from the session.
 */
export function takeTeamMail(session: Session, emitter: TurnEmitter, persister: StepPersister): ModelMessage | null {
    // wait_for_team takes the mail itself and returns it as its result.
    if (isWaiting(session.id)) return null;
    const team = teamOf(session.id);
    if (!team) return null;
    const mail = mailViews(takeInbox(session.id));
    if (mail.length === 0) return null;
    const text = formatMailForModel(mail);
    const meta: TeamTurnMeta = { kind: "mail", teamId: team.teamId, mail, midTurn: true };
    void persister.enqueue(async () => {
        const entry: Entry = { type: "message", ts: Date.now(), role: "user", content: text, team: meta };
        await session.append(entry);
        emitter.emit("team-message", { id: entry.id ?? "", team: meta, ts: entry.ts });
    }, "team mail persistence");
    return { role: "user", content: text };
}
