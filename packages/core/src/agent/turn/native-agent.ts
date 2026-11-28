/**
 * What a loop turn hands a native agent (Claude Code, Codex, Cursor,
 * Antigravity) beyond the messages: its own system prompt, and a channel for
 * live progress of work running inside the agent.
 *
 * A native agent brings its own system prompt and tools, so loop's prompt —
 * which documents loop's tools — would only confuse it. What it lacks is the
 * context loop keeps for the project: instruction files it doesn't load
 * itself (Claude Code never reads AGENTS.md), loop's memory, loop's skills.
 */
import { getSetting } from "../../settings";
import { NATIVE_CONTEXT_FILES, setNativeProgressSink, type NativeAgentProviderId } from "../../providers";
import { loadWorkspaceContext } from "../context";
import type { TurnEmitter } from "../events";
import type { ProjectContext } from "./opening";

const INTRO =
    "You are running inside loop, the user's coding agent. Below is context loop keeps for this project: " +
    "instruction files you don't load yourself, loop's memory for this project, and loop's skills. " +
    "Follow it as you would your own instructions, using your own tools.";

export function buildNativeAgentPrompt(provider: NativeAgentProviderId, cwd: string, project: ProjectContext): string {
    const workspace =
        getSetting("workspaceContext") !== false
            ? loadWorkspaceContext(cwd, { skip: NATIVE_CONTEXT_FILES[provider] }).text
            : "";
    const parts = [workspace, project.memoryContext, project.skillsPrompt.trim()].filter(Boolean);
    return parts.length ? [INTRO, ...parts].join("\n\n") : "";
}

/**
 * Report a native agent's subagent work into the turn's emitter for as long
 * as the turn runs — the same events loop's own subagents emit, so the task
 * box renders both alike. Returns the unregister.
 */
export function forwardNativeProgress(sessionId: string, emitter: TurnEmitter): () => void {
    return setNativeProgressSink(sessionId, {
        text: (toolCallId, agent, text) => emitter.emit("subagent-delta", { toolCallId, agent, text }),
        tool: (toolCallId, agent, toolName, input) =>
            emitter.emit("subagent-tool", { toolCallId, agent, toolName, input }),
    });
}
