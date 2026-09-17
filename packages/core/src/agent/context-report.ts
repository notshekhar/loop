/**
 * /context — per-category estimate of what fills the model's context window.
 *
 * Mirrors runTurn's assembly (same settings/trust gating, same helpers) but
 * read-only: nothing here connects, persists, or mutates. All numbers use the
 * chars/4 heuristic from model-messages.ts — providers only ever report one
 * total, so a breakdown is necessarily an estimate.
 */
import { getCatalog } from "../catalog";
import { getSetting } from "../settings";
import { getMcpManager, isMcpEnabled, shouldUseToolSearch } from "../mcp";
import { getExtensionHost } from "../extensions";
import { parseModelId } from "../providers";
import {
    createAskTool,
    createSkillTool,
    createTools,
    SHELLS_TOOL_NAME,
    createWebsearchTool,
    isAskUserAvailable,
    SKILL_TOOL_NAME,
    TODO_TOOL_NAME,
    createMcpResourceTool,
    MCP_RESOURCE_TOOL_NAME,
    createMcpToolsTool,
    MCP_TOOLS_TOOL_NAME,
} from "../tools";
import type { Session } from "../sessions";
import { getAgentPrompt, getAgentTools, listAgents } from "./agents";
import { loadWorkspaceContext } from "./context";
import { loadMemoryContext } from "./memory";
import { loadProjectSkills } from "./skills";
import { isTrusted } from "./trust";
import { buildBackgroundShellsNote, buildSubagentNote, buildSystemPrompt, buildTodoNote } from "./system-prompt";
import { applySystemPrompt } from "./turn-middleware";
import { latestCompactEntry } from "./compact";

export interface ContextCategory {
    key:
        | "systemPrompt"
        | "extensionPrompt"
        | "systemTools"
        | "mcpTools"
        | "workspaceContext"
        | "memory"
        | "skills"
        | "messages"
        | "compactSummary";
    label: string;
    tokens: number;
}

export interface SkillTokenEstimate {
    name: string;
    tokens: number;
}

export interface ContextReport {
    modelId: string;
    contextWindow: number;
    autoCompactThreshold: number;
    categories: ContextCategory[];
    /** Sum of all categories (estimated used tokens). */
    totalTokens: number;
    freeTokens: number;
    skills: SkillTokenEstimate[];
    toolCount: number;
    mcpToolCount: number;
}

const chars4 = (n: number) => Math.ceil(n / 4);

/** Same shape as estimateOverheadTokens: name + description at chars/4 plus a
 * flat allowance per tool for the JSON schema body. */
const TOOL_SCHEMA_ALLOWANCE_TOKENS = 120;

function toolTokens(tools: Record<string, unknown>): number {
    let chars = 0;
    let count = 0;
    for (const [name, tool] of Object.entries(tools)) {
        chars += name.length + ((tool as { description?: string })?.description?.length ?? 0);
        count++;
    }
    return chars4(chars) + count * TOOL_SCHEMA_ALLOWANCE_TOKENS;
}

/** The task tool is assembled per-turn with live wiring, so it can't be built
 * here — count its prompt surface (description + schema) as a flat estimate. */
const TASK_TOOL_EST_TOKENS = 400;

/** Same story for the todo tool (needs a live session + emitter). */
const TODO_TOOL_EST_TOKENS = 420;

export async function buildContextReport(opts: {
    session: Session | null;
    modelId: string;
    cwd: string;
    agent?: string;
}): Promise<ContextReport> {
    const { session, modelId, cwd } = opts;
    const catalog = await getCatalog();
    const contextWindow = catalog[modelId]?.contextWindow ?? 0;
    const autoCompactThreshold = getSetting("autoCompactThreshold") ?? 0.8;

    const workspace = getSetting("workspaceContext") !== false ? loadWorkspaceContext(cwd) : { text: "", files: [] };
    const memoryText = getSetting("memory") !== false ? loadMemoryContext(cwd).text : "";
    const skillsEnabled = getSetting("skills") !== false && isTrusted(cwd);
    const skills = skillsEnabled ? await loadProjectSkills(cwd) : { skills: [], diagnostics: [], promptBlock: "" };

    const agentPrompt = opts.agent ? getAgentPrompt(opts.agent) : undefined;
    const allowedTools = opts.agent ? getAgentTools(opts.agent) : undefined;

    // Builtin + extension tools (what runTurn calls "system tools").
    const fullToolSet = createTools({ cwd, sessionId: session?.id ?? "context-report" });
    const toolSet: Record<string, unknown> = allowedTools?.length
        ? Object.fromEntries(Object.entries(fullToolSet).filter(([name]) => allowedTools.includes(name)))
        : { ...fullToolSet };
    if (!allowedTools?.length && isTrusted(cwd)) {
        const ext = getExtensionHost().getTools();
        for (const [name, tool] of ext.add) toolSet[name] = tool;
        for (const name of ext.remove) delete toolSet[name];
    }
    // Conditional tools, same gates as assembleTurnTools. websearch/ask build
    // for real (construction is pure); todo needs live wiring → flat estimate.
    if (getSetting("webSearch") === true && (!allowedTools?.length || allowedTools.includes("websearch"))) {
        toolSet.websearch = createWebsearchTool({});
    }
    if (
        getSetting("askUser") === true &&
        isAskUserAvailable() &&
        (!allowedTools?.length || allowedTools.includes("ask"))
    ) {
        toolSet.ask = createAskTool({});
    }
    const visibleSkills = skills.skills.filter((s) => !s.disableModelInvocation);
    if (visibleSkills.length > 0 && (!allowedTools?.length || allowedTools.includes(SKILL_TOOL_NAME))) {
        toolSet[SKILL_TOOL_NAME] = createSkillTool({ skills: visibleSkills });
    }
    // Same gate as assembleTurnTools: with background shells off the shells
    // tool is never offered, so it must not be measured either.
    if (getSetting("backgroundShells") !== true) delete toolSet[SHELLS_TOOL_NAME];
    const todosEnabled =
        getSetting("todos") === true && (!allowedTools?.length || allowedTools.includes(TODO_TOOL_NAME));

    // Trust is applied when servers connect, not when their tools are counted —
    // see the same gate in turn.ts.
    // Built exactly as turn.ts builds it, resource reader included, so the
    // category's name list, tool count and token measure all describe the same
    // set — a breakdown that under-reports by one tool is one nobody trusts.
    const mcpManager = getMcpManager();
    const mcpAttached = isMcpEnabled() && !allowedTools?.length;
    const mcpResourceAttached =
        mcpAttached && (mcpManager.listResources().length > 0 || mcpManager.listResourceTemplates().length > 0);
    // Search mode advertises ONE tool in place of all of them, and the whole
    // point is the context it saves — a breakdown that kept counting the hidden
    // tools would report the opposite of what happened.
    const rawMcpTools = mcpAttached ? mcpManager.getTools() : {};
    const searchMode = mcpAttached && shouldUseToolSearch(Object.keys(rawMcpTools).length);
    const mcpTools = {
        ...(searchMode
            ? { [MCP_TOOLS_TOOL_NAME]: createMcpToolsTool({ tools: () => mcpManager.getTools() }) }
            : rawMcpTools),
        ...(mcpResourceAttached
            ? {
                  [MCP_RESOURCE_TOOL_NAME]: createMcpResourceTool({
                      listResources: () => mcpManager.listResources(),
                      listResourceTemplates: () => mcpManager.listResourceTemplates(),
                      readResource: (server, uri) => mcpManager.readResource(server, uri),
                  }),
              }
            : {}),
    };
    const mcpToolCount = Object.keys(mcpTools).length;

    const subagentsEnabled =
        getSetting("subagents") !== false && (!allowedTools?.length || allowedTools.includes("task"));
    const subagentNote = subagentsEnabled ? buildSubagentNote(listAgents().map((a) => a.name)) : "";

    // System prompt measured WITHOUT workspace context / skills — those are
    // separate categories below.
    const toolNames = [
        ...Object.keys(toolSet),
        ...Object.keys(mcpTools),
        ...(subagentsEnabled ? ["task"] : []),
        ...(todosEnabled ? [TODO_TOOL_NAME] : []),
    ];
    const todoNote = todosEnabled ? buildTodoNote() : "";
    const backgroundShellsNote = SHELLS_TOOL_NAME in toolSet ? buildBackgroundShellsNote() : "";
    const systemBase =
        buildSystemPrompt({ cwd, basePrompt: agentPrompt, tools: toolNames }) +
        subagentNote +
        todoNote +
        backgroundShellsNote;
    // Extension turn middleware (onSystemPrompt — e.g. the caveman/ponytail
    // builtins) reshapes the prompt in runTurn; run the same transform here so
    // injected text is billed context /context actually shows. The middleware
    // chain is fail-soft and read-only over a synthetic TurnContext.
    const { provider, model } = parseModelId(modelId);
    const systemFinal = await applySystemPrompt(systemBase, {
        sessionId: session?.id ?? "context-report",
        transcriptPath: session?.path ?? "",
        cwd,
        agent: opts.agent ?? "default",
        modelId,
        provider,
        model,
        tools: toolNames,
        isSubagent: false,
        contextWindow: 0,
    });
    const systemBaseTokens = chars4(systemBase.length);
    const systemFinalTokens = chars4(systemFinal.length);
    // Extensions may also shrink the prompt — then the smaller number IS the
    // system prompt; a separate category only exists for net injection.
    const extensionPromptTokens = Math.max(0, systemFinalTokens - systemBaseTokens);
    const systemPromptTokens = Math.min(systemBaseTokens, systemFinalTokens);

    let systemToolTokens = toolTokens(toolSet);
    if (subagentsEnabled) systemToolTokens += TASK_TOOL_EST_TOKENS;
    if (todosEnabled) systemToolTokens += TODO_TOOL_EST_TOKENS;

    // Transcript walk — same branch/compaction rules as estimateContextTokens,
    // split into the compact summary vs live messages.
    let messageChars = 0;
    let compactTokens = 0;
    if (session) {
        const compact = latestCompactEntry(session);
        if (compact) compactTokens = chars4(compact.summary.length + 200);
        let messageIndex = 0;
        for (const e of session.getBranch()) {
            if (e.type === "message") {
                const idx = messageIndex++;
                if (compact && idx < compact.cutAt) continue;
            } else if (e.type === "subagent" || e.type === "branch-summary") {
                if (compact && messageIndex < compact.cutAt) continue;
            } else {
                continue;
            }
            messageChars += JSON.stringify(e).length;
        }
    }

    const categories: ContextCategory[] = [
        { key: "systemPrompt", label: "System prompt", tokens: systemPromptTokens },
        ...(extensionPromptTokens > 0
            ? [{ key: "extensionPrompt", label: "Extension prompt", tokens: extensionPromptTokens } as ContextCategory]
            : []),
        { key: "systemTools", label: "System tools", tokens: systemToolTokens },
        ...(mcpToolCount > 0
            ? [{ key: "mcpTools", label: "MCP tools", tokens: toolTokens(mcpTools) } as ContextCategory]
            : []),
        ...(workspace.text
            ? [
                  {
                      key: "workspaceContext",
                      label: "Workspace context",
                      tokens: chars4(workspace.text.length),
                  } as ContextCategory,
              ]
            : []),
        ...(memoryText
            ? [{ key: "memory", label: "Memory", tokens: chars4(memoryText.length) } as ContextCategory]
            : []),
        ...(skills.promptBlock
            ? [{ key: "skills", label: "Skills", tokens: chars4(skills.promptBlock.length) } as ContextCategory]
            : []),
        { key: "messages", label: "Messages", tokens: chars4(messageChars) },
        ...(compactTokens > 0
            ? [{ key: "compactSummary", label: "Compact summary", tokens: compactTokens } as ContextCategory]
            : []),
    ];

    const totalTokens = categories.reduce((sum, c) => sum + c.tokens, 0);
    // Per-skill estimate: each skill's <skill> entry in the prompt block is its
    // escaped name + description plus the XML wrapper.
    const skillEstimates: SkillTokenEstimate[] = skills.skills
        .filter((s) => !s.disableModelInvocation)
        .map((s) => ({ name: s.name, tokens: chars4(s.name.length + s.description.length + 40) }))
        .sort((a, b) => b.tokens - a.tokens);

    return {
        modelId,
        contextWindow,
        autoCompactThreshold,
        categories,
        totalTokens,
        freeTokens: Math.max(0, contextWindow - totalTokens),
        skills: skillEstimates,
        toolCount: Object.keys(toolSet).length + (subagentsEnabled ? 1 : 0) + (todosEnabled ? 1 : 0),
        mcpToolCount,
    };
}
