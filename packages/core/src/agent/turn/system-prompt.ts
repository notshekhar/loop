/**
 * The system prompt of one turn: the base prompt plus a guidance note per
 * capability. Every note is keyed off the ASSEMBLED toolset, not the settings
 * that produced it, so an extension that dropped a tool in onAssembleTools —
 * or a restricted agent denied it — is never told how to use what it hasn't got.
 */
import { createHash } from "node:crypto";
import {
    buildMcpToolSearchNote,
    EXIT_PLAN_MODE_TOOL_NAME,
    MCP_TOOLS_TOOL_NAME,
    SHELLS_TOOL_NAME,
    SKILL_TOOL_NAME,
    TODO_TOOL_NAME,
} from "../../tools";
import { getMcpManager } from "../../mcp";
import { debugLog, isDebugEnabled } from "../../debug";
import { buildTeamLeadNote, buildTeamMemberNote, maxTeamThreads, REPORT_TOOL, SPAWN_THREADS_TOOL } from "../../teams";
import { listAgents } from "../agents";
import { formatSkillsForPrompt, type Skill } from "../skills";
import {
    buildBackgroundShellsNote,
    buildMcpInstructionsNote,
    buildPlanModeNote,
    buildSubagentNote,
    buildSystemPrompt,
    buildTodoNote,
} from "../system-prompt";

export interface TurnPromptInputs {
    cwd: string;
    workspaceContext: string;
    memoryContext: string;
    agentPrompt: string | undefined;
    skills: Skill[];
    skillsPrompt: string;
}

export function buildTurnSystemPrompt(toolsForTurn: Record<string, unknown>, inputs: TurnPromptInputs): string {
    const has = (name: string) => name in toolsForTurn;
    const base = buildSystemPrompt({
        cwd: inputs.cwd,
        workspaceContext: inputs.workspaceContext,
        memoryContext: inputs.memoryContext,
        basePrompt: inputs.agentPrompt,
        tools: Object.keys(toolsForTurn),
    });
    // Checked post-assembly so an extension removing the skill tool also
    // flips the wording back to "read the file".
    const skillsBlock = has(SKILL_TOOL_NAME)
        ? formatSkillsForPrompt(inputs.skills, { viaTool: true })
        : inputs.skillsPrompt;
    return [
        base,
        has("task") ? buildSubagentNote(listAgents().map((a) => a.name)) : "",
        teamNote(has),
        has(TODO_TOOL_NAME) ? buildTodoNote() : "",
        has(SHELLS_TOOL_NAME) ? buildBackgroundShellsNote() : "",
        // Tell the model it is planning rather than letting it find out from a
        // rejected edit. Only when it can actually exit — everyone else is told
        // by the plan tool's own description.
        has(EXIT_PLAN_MODE_TOOL_NAME) ? buildPlanModeNote() : "",
        ...mcpNotes(toolsForTurn),
        skillsBlock ?? "",
    ].join("");
}

/**
 * A lead is offered spawn_threads, a member report. No roster here — it would
 * change the prompt whenever someone joins (see teams/prompts.ts); the team
 * travels in saved messages instead.
 */
function teamNote(has: (name: string) => boolean): string {
    if (has(SPAWN_THREADS_TOOL)) return buildTeamLeadNote({ maxThreads: maxTeamThreads() });
    if (has(REPORT_TOOL)) return buildTeamMemberNote();
    return "";
}

/** The tool-search note, then the servers' own instructions. */
function mcpNotes(toolsForTurn: Record<string, unknown>): [string, string] {
    const searchMode = MCP_TOOLS_TOOL_NAME in toolsForTurn;
    const hasMcpTools = searchMode || Object.keys(toolsForTurn).some((name) => name.startsWith("mcp__"));
    if (!hasMcpTools) return ["", ""];
    const servers = getMcpManager().listServers();
    // A model shown one unfamiliar tool where it expected a server's tools
    // usually concludes the capability is missing rather than searching for
    // it. Configured servers, not just ready ones: one finishing its
    // connection between turns must not change the prompt (and so the cache).
    const toolSearch = searchMode
        ? buildMcpToolSearchNote(servers.filter((s) => s.status !== "disabled").map((s) => s.name))
        : "";
    return [toolSearch, buildMcpInstructionsNote(servers)];
}

/**
 * The cached prefix Anthropic reuses across turns is tools → system prompt.
 * Anything that changes either between two turns of a session re-bills the
 * whole conversation at full input price, so with LOOP_DEBUG=1 say which half
 * moved — the breadcrumb that catches the next volatile line in the prompt.
 */
const lastPrefixHashes = new Map<string, { system: string; tools: string }>();

export function notePrefixChange(sessionId: string, system: string, tools: Record<string, unknown>): void {
    if (!isDebugEnabled()) return;
    const hash = (text: string) => createHash("sha1").update(text).digest("hex");
    const now = {
        system: hash(system),
        tools: hash(
            JSON.stringify(
                Object.entries(tools).map(([name, t]) => [name, (t as { description?: string })?.description]),
            ),
        ),
    };
    const before = lastPrefixHashes.get(sessionId);
    lastPrefixHashes.set(sessionId, now);
    if (!before) return;
    const moved = [before.system !== now.system && "system prompt", before.tools !== now.tools && "tools"].filter(
        Boolean,
    );
    if (moved.length > 0) debugLog("cache", `prompt prefix changed (${moved.join(" + ")}) in session ${sessionId}`);
}
