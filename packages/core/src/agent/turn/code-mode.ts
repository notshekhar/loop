/**
 * Code Mode for a turn: the opt-in `codeMode` setting folds the turn's tools
 * into one `code` tool whose scripts call them.
 *
 * Folded AFTER the hook wrapping, so each call a script makes runs the
 * hook-wrapped execute — and the code tool is wrapped too, so a hook matching
 * `code` sees the script itself. Tools that talk to the user or steer the turn
 * stay direct: a script can't sensibly wait on a question, hand off a plan or
 * start a subagent from inside a sandbox.
 */
import { getSetting } from "../../settings";
import { isNativeAgentProvider } from "../../providers";
import {
    CODE_TOOL_NAME,
    createCodeTool,
    ENTER_PLAN_MODE_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    PLAN_TOOL_NAME,
    SKILL_TOOL_NAME,
    TODO_TOOL_NAME,
    type BridgedTool,
    type CodeRunPayload,
    type NestedCallSink,
} from "../../tools";
import type { Session } from "../../sessions";
import { REPORT_TOOL, SEND_MESSAGE_TOOL, SPAWN_THREADS_TOOL, TEAM_BOARD_TOOL, WAIT_FOR_TEAM_TOOL } from "../../teams";
import type { TurnEmitter } from "../events";

type ToolMap = Record<string, unknown>;

/** Tools offered directly even in Code Mode. */
const DIRECT_TOOLS: ReadonlySet<string> = new Set([
    "ask",
    "task",
    TODO_TOOL_NAME,
    SKILL_TOOL_NAME,
    PLAN_TOOL_NAME,
    ENTER_PLAN_MODE_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    SPAWN_THREADS_TOOL,
    SEND_MESSAGE_TOOL,
    TEAM_BOARD_TOOL,
    WAIT_FOR_TEAM_TOOL,
    REPORT_TOOL,
]);

/** Native agents (Claude Code, Cursor…) run their own tools, so they never fold. */
export function isCodeModeOn(provider: string): boolean {
    return getSetting("codeMode") === true && !isNativeAgentProvider(provider);
}

export interface CodeModeFoldContext {
    emitter: TurnEmitter;
    /** Where a run's calls are saved for replay; absent = not saved (the /context estimate). */
    session?: Session;
    abortSignal?: AbortSignal;
    /** The turn's hook wrapper, applied to the code tool itself. */
    wrap: (tools: ToolMap) => ToolMap;
}

/**
 * `hooked` (already hook-wrapped) → the direct tools plus `code`. With nothing
 * left to fold, the map is returned as it was.
 */
export async function foldIntoCodeTool(hooked: ToolMap, ctx: CodeModeFoldContext): Promise<ToolMap> {
    const direct: ToolMap = {};
    const folded: Record<string, BridgedTool> = {};
    for (const [name, t] of Object.entries(hooked)) {
        if (DIRECT_TOOLS.has(name)) direct[name] = t;
        else folded[name] = t as BridgedTool;
    }
    if (Object.keys(folded).length === 0) return hooked;
    const code = await createCodeTool({
        tools: folded,
        sink: emitterSink(ctx.emitter),
        ...(ctx.session ? { recordRun: recorderFor(ctx.session) } : {}),
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    });
    return { ...direct, ...ctx.wrap({ [CODE_TOOL_NAME]: code }) };
}

/** Saved like a todo list: a custom entry the model never reads, the UIs replay. */
function recorderFor(session: Session): (payload: CodeRunPayload) => Promise<void> {
    return (payload) => session.append({ type: "custom", ts: Date.now(), payload });
}

/**
 * A script's calls go out as the turn's ordinary tool events, so every surface
 * that already draws tool rows (TUI, desktop, /rc clients) draws these too.
 */
function emitterSink(emitter: TurnEmitter): NestedCallSink {
    return {
        started: ({ id, toolName, input }) => emitter.emit("tool-call", { toolCallId: id, toolName, input }),
        finished: (id, output) => emitter.emit("tool-result", { toolCallId: id, output }),
        failed: (id, toolName, error) => emitter.emit("tool-error", { toolCallId: id, toolName, error }),
    };
}
