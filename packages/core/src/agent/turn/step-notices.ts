/**
 * What rides into each step's request besides the conversation: the caching
 * tail-move, team mail, background-shell exits and the todo nudge.
 *
 * One-step notices (a shell exit, a todo nudge) go on the end of ONE request
 * and are never saved. What prepareStep returns is the next step's starting
 * list (AI SDK v7), so each is taken back out on the step after — otherwise it
 * would sit in every later step of the turn while a rebuilt attempt or the
 * next turn never had it. Appended AFTER the caching prepareStep, so the cache
 * breakpoint stays on history that lasts and taking a notice out never moves
 * the cached prefix. The SDK carries the same objects forward, so they are
 * recognised by identity.
 *
 * Team mail is different: added ONCE, at the end of the step it arrives on,
 * it stays where it went in on every later step, so the cached prefix never
 * moves (see team.ts).
 */
import type { ModelMessage } from "ai";
import {
    createTodoNudger,
    formatShellNotices,
    getSessionTodos,
    SHELLS_TOOL_NAME,
    takeShellNotices,
    TODO_TOOL_NAME,
} from "../../tools";
import { SEND_MESSAGE_TOOL, teamOf } from "../../teams";
import { debugLog } from "../../debug";
import type { Session } from "../../sessions";
import type { TurnEmitter } from "../events";
import type { AgentCallConfig } from "../model-call";
import type { StepPersister } from "./step-persistence";
import { takeTeamMail } from "./team";

interface PrepareStepInput {
    messages: ModelMessage[];
    steps?: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: string }> }>;
}

export type PrepareStep = (input: PrepareStepInput) => { messages: ModelMessage[] };

export interface StepNoticeSources {
    session: Session;
    emitter: TurnEmitter;
    persister: StepPersister;
    toolsForTurn: Record<string, unknown>;
    basePrepareStep: AgentCallConfig["prepareStep"];
}

/** undefined when nothing would ever be added, so the SDK skips the hook. */
export function createPrepareStep(sources: StepNoticeSources): PrepareStep | undefined {
    const { session, toolsForTurn, basePrepareStep } = sources;
    const notices = new OneStepNotices();
    const todoNudger = TODO_TOOL_NAME in toolsForTurn ? createTodoNudger(() => getSessionTodos(session.id)) : null;
    // Background shells announce their own exits: without this "you will be
    // told when it exits" is a promise the tool cannot keep, and the model
    // falls back to sleeping and polling.
    const announcesShells = SHELLS_TOOL_NAME in toolsForTurn;
    // The team tools are a turn's only way into a team, and a member is in
    // one already. Checked every step, not once: a lead's team can start mid-turn.
    const mayGetTeamMail = SEND_MESSAGE_TOOL in toolsForTurn || teamOf(session.id) !== null;
    if (!todoNudger && !announcesShells && !basePrepareStep && !mayGetTeamMail) return undefined;

    return (input) => {
        const carried = notices.removeFrom(input.messages);
        const mail = mayGetTeamMail ? takeTeamMail(session, sources.emitter, sources.persister) : null;
        const withMail = mail ? [...carried, mail] : carried;
        let messages = basePrepareStep ? basePrepareStep({ messages: withMail }).messages : withMail;
        if (announcesShells) messages = notices.append(messages, shellExitNotice(session.id));
        if (todoNudger) messages = notices.append(messages, todoNudge(todoNudger, input, session.id));
        return { messages };
    };
}

class OneStepNotices {
    private readonly sent = new WeakSet<ModelMessage>();

    append(messages: ModelMessage[], content: string | null): ModelMessage[] {
        if (!content) return messages;
        const message: ModelMessage = { role: "user", content };
        this.sent.add(message);
        return [...messages, message];
    }

    removeFrom(messages: ModelMessage[]): ModelMessage[] {
        return messages.some((m) => this.sent.has(m)) ? messages.filter((m) => !this.sent.has(m)) : messages;
    }
}

/** A shell that finished between steps is reported once, then cleared. */
function shellExitNotice(sessionId: string): string | null {
    const notice = formatShellNotices(takeShellNotices(sessionId));
    if (notice) debugLog("shells", `exit notice injected (session ${sessionId})`);
    return notice || null;
}

/** A system-reminder when the checklist has gone unmaintained for many tool calls. */
function todoNudge(
    nudger: ReturnType<typeof createTodoNudger>,
    input: PrepareStepInput,
    sessionId: string,
): string | null {
    const calls: string[] = [];
    for (const s of input.steps ?? []) {
        for (const c of s.toolCalls ?? []) if (c.toolName) calls.push(c.toolName);
    }
    const nudge = nudger(calls);
    if (nudge) debugLog("todo", `nudge injected after ${calls.length} tool calls (session ${sessionId})`);
    return nudge || null;
}
