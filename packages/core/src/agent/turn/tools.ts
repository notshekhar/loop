/**
 * The turn's tool-assembly matrix: per-agent restriction, websearch/MCP/
 * extension/task/ask/plan gating, the TurnContext handed to every middleware
 * seam, and the extension onAssembleTools pass.
 *
 * Order matters and is the reason for the split below: tools added BEFORE the
 * task tool land in its `parentTools`, so a subagent inherits them; tools
 * added AFTER it stay with the parent.
 */
import {
    ARTIFACT_TOOL_NAME,
    createArtifactTool,
    createAskTool,
    createBaseTools,
    createEnterPlanModeTool,
    createExitPlanModeTool,
    createMcpResourceTool,
    createMcpToolsTool,
    createPlanTool,
    createSkillTool,
    createTodoTool,
    createWebsearchTool,
    ENTER_PLAN_MODE_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    getBashApprovalBridge,
    isAskUserAvailable,
    isPlanModeActive,
    MCP_RESOURCE_TOOL_NAME,
    MCP_TOOLS_TOOL_NAME,
    PLAN_TOOL_NAME,
    SHELLS_TOOL_NAME,
    SKILL_TOOL_NAME,
    TODO_TOOL_NAME,
} from "../../tools";
import { getSetting } from "../../settings";
import { isNativeAgentProvider } from "../../providers";
import { getMcpManager, isMcpEnabled, shouldUseToolSearch } from "../../mcp";
import { getExtensionHost } from "../../extensions";
import type { TurnContext } from "../../extensions/api";
import { createTeamTools, isThreadTeamsEnabled } from "../../teams";
import { getAgentPrompt, getAgentTools, isReadOnlyBashAgent } from "../agents";
import type { Skill } from "../skills";
import { createTaskTool } from "../subagent";
import { isTrusted } from "../trust";
import { applyAssembleTools } from "../turn-middleware";
import type { RunTurnOptions } from "./types";

type ToolMap = Record<string, unknown>;

export interface TurnToolInputs {
    provider: string;
    modelShortId: string;
    workspaceContext: string;
    skillsPrompt: string;
    skills: Skill[];
}

/** undefined = an unrestricted agent (every tool). */
type AllowedTools = string[] | undefined;

const isUnrestricted = (allowed: AllowedTools) => !allowed?.length;

/** An unrestricted agent gets the tool; a restricted one only when it names it. */
const allows = (allowed: AllowedTools, name: string) => isUnrestricted(allowed) || allowed!.includes(name);

export async function assembleTurnTools(opts: RunTurnOptions, extra: TurnToolInputs) {
    const agentPrompt = opts.agent ? getAgentPrompt(opts.agent) : undefined;
    // Per-agent tool restriction (e.g. plan = read-only). undefined = all tools.
    const allowedTools = opts.agent ? getAgentTools(opts.agent) : undefined;
    const fullToolSet = createBaseTools({
        cwd: opts.cwd,
        abortSignal: opts.abortSignal,
        // An agent allowed bash but NOT write/edit (e.g. plan) gets bash forced
        // into a fail-closed read-only sandbox, so the kernel guarantees no mutation.
        readOnlyFs: isReadOnlyBashAgent(allowedTools),
        sessionId: opts.session.id,
    });
    const tools: ToolMap = isUnrestricted(allowedTools)
        ? { ...fullToolSet }
        : Object.fromEntries(Object.entries(fullToolSet).filter(([name]) => allowedTools!.includes(name)));

    addInheritableTools(tools, opts, allowedTools);
    addTaskTool(tools, opts, allowedTools, extra);
    addParentOnlyTools(tools, opts, allowedTools, extra);
    addPlanModeTools(tools, opts, allowedTools);

    const { toolsForTurn, turnContext } = await finishAssembly(tools, opts, extra);
    return { toolsForTurn, fullToolSet, turnContext, agentPrompt };
}

/** Tools added before the task tool, so a subagent fork inherits them. */
function addInheritableTools(tools: ToolMap, opts: RunTurnOptions, allowed: AllowedTools): void {
    // Background shells: the opt-in `backgroundShells` setting (default off)
    // gates the whole capability. Off means the shells tool is not offered at
    // all — bash refuses run_in_background separately, so the model can neither
    // start one nor be handed a tool for reading shells that cannot exist.
    if (getSetting("backgroundShells") !== true) delete tools[SHELLS_TOOL_NAME];

    // Websearch: opt-in `webSearch` setting (default off) — DuckDuckGo HTML
    // scraping, no API key, no UI bridge, so print mode gets it too.
    if (getSetting("webSearch") === true && allows(allowed, "websearch")) {
        tools.websearch = createWebsearchTool({ abortSignal: opts.abortSignal });
    }

    // Artifacts: opt-in `artifacts` setting (default off). Publishes a file the
    // agent wrote with the ordinary write tool, so it is useless to an agent
    // that has no write tool — a restricted read-only agent like plan never
    // gets it, even by naming it. Inherited so a subagent researching and
    // drafting a report can publish its own result.
    if (
        getSetting("artifacts") === true &&
        (isUnrestricted(allowed) || (allowed!.includes(ARTIFACT_TOOL_NAME) && allowed!.includes("write")))
    ) {
        tools[ARTIFACT_TOOL_NAME] = createArtifactTool({ abortSignal: opts.abortSignal, sessionId: opts.session.id });
    }

    // MCP and extension tools join unrestricted agents only — a restricted
    // agent (e.g. plan) keeps its explicit allowlist, and a named subagent can
    // only narrow what it inherits, never widen it.
    if (!isUnrestricted(allowed)) return;
    if (isMcpEnabled()) addMcpTools(tools);
    // With no extensions loaded both maps are empty, so the turn's toolset is
    // byte-for-byte the builtin set. Removals drop builtins an extension
    // explicitly overrode.
    if (isTrusted(opts.cwd)) {
        const ext = getExtensionHost().getTools();
        for (const [name, tool] of ext.add) tools[name] = tool as never;
        for (const name of ext.remove) delete tools[name];
    }
}

/**
 * MCP tools, already namespaced mcp__server__tool. Not trust-gated here: the
 * manager already decided which servers were allowed to connect in this
 * folder (user-scope always, project-scope only when trusted), so anything it
 * holds tools for has passed that test.
 */
function addMcpTools(tools: ToolMap): void {
    const mcp = getMcpManager();
    const mcpTools = mcp.getTools();
    if (shouldUseToolSearch(Object.keys(mcpTools).length)) {
        // The tools are NOT advertised; mcp_tools reaches them by name.
        // Read through a callback rather than captured, so a server that
        // connects or drops mid-turn is reflected on the next call.
        tools[MCP_TOOLS_TOOL_NAME] = createMcpToolsTool({ tools: () => getMcpManager().getTools() }) as never;
    } else {
        Object.assign(tools, mcpTools);
    }
    // The resource reader rides along only when a connected server actually
    // publishes resources: a tools-only setup (which is most of them) should
    // not pay a tool slot to be told there is nothing to read.
    if (mcp.listResources().length > 0 || mcp.listResourceTemplates().length > 0) {
        tools[MCP_RESOURCE_TOOL_NAME] = createMcpResourceTool({
            listResources: () => mcp.listResources(),
            listResourceTemplates: () => mcp.listResourceTemplates(),
            readResource: (server, uri) => mcp.readResource(server, uri),
        }) as never;
    }
}

/**
 * Subagents: the master `subagents` setting gates the task tool entirely.
 * Otherwise unrestricted agents always get it; restricted agents only when
 * their tool list opts in ("task"). A subagent's tools are capped to this
 * turn's, so delegation never widens access, and it never gets task itself.
 */
function addTaskTool(tools: ToolMap, opts: RunTurnOptions, allowed: AllowedTools, extra: TurnToolInputs): void {
    if (getSetting("subagents") === false || !allows(allowed, "task")) return;
    const { session } = opts;
    tools.task = createTaskTool({
        modelId: opts.modelId,
        cwd: opts.cwd,
        tracker: opts.tracker,
        emitter: opts.emitter,
        abortSignal: opts.abortSignal,
        session,
        sessionId: session.id,
        transcriptPath: session.path,
        turnAgent: opts.agent,
        // Everything the parent can call (incl. MCP); task isn't added yet,
        // so it can't recurse into itself.
        parentTools: Object.keys(tools),
        workspaceContext: extra.workspaceContext,
        skillsPrompt: extra.skillsPrompt,
    });
}

/** Tools added after the task tool, so subagents never inherit them. */
function addParentOnlyTools(tools: ToolMap, opts: RunTurnOptions, allowed: AllowedTools, extra: TurnToolInputs): void {
    const { session } = opts;
    // Skill tool: attached whenever this turn has visible skills (same
    // `skills` setting + trust gate that loaded them). Subagents keep the
    // read-tool wording, so the read path stays a working fallback everywhere.
    const visibleSkills = extra.skills.filter((s) => !s.disableModelInvocation);
    if (visibleSkills.length > 0 && allows(allowed, SKILL_TOOL_NAME)) {
        tools[SKILL_TOOL_NAME] = createSkillTool({ skills: visibleSkills });
    }
    // Todo tool (default OFF): parallel subagents rewriting one pinned panel
    // would fight the parent.
    if (getSetting("todos") === true && allows(allowed, TODO_TOOL_NAME)) {
        tools[TODO_TOOL_NAME] = createTodoTool({ sessionId: session.id, session, emitter: opts.emitter });
    }
    // Thread teams (default off), unrestricted agents only — a read-only agent
    // has no business starting writers. Native agents (Claude Code, Cursor)
    // run their own loop with their own tools, so they never get these.
    if (isThreadTeamsEnabled() && isUnrestricted(allowed) && !isNativeAgentProvider(extra.provider)) {
        Object.assign(
            tools,
            createTeamTools({
                session,
                modelId: opts.modelId,
                cwd: opts.cwd,
                abortSignal: opts.abortSignal,
                ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
            }),
        );
    }
    // Ask tool: the `askUser` setting AND a live interactive UI bridge
    // (absent in print mode, so the tool is never offered there).
    if (getSetting("askUser") === true && isAskUserAvailable() && allows(allowed, "ask")) {
        tools.ask = createAskTool({ abortSignal: opts.abortSignal });
    }
}

/**
 * A plan-mode session must always have exactly ONE way to deliver its plan —
 * two overlapping delivery tools just confuse the model:
 *
 *   exit_plan_mode — unrestricted agent + an approval bridge. The user
 *     approves mid-turn, the gate lifts, and this same agent implements the
 *     plan it just wrote, context intact. Does NOT stop the turn.
 *   plan — everyone else (the restricted plan builtin, custom read-only
 *     agents, print mode / RPC where nobody can be asked). Delivery stops the
 *     turn; the TUI's implement/talk follow-up hands it onward.
 *
 * enter_plan_mode is the agent-initiated way in: unrestricted, interactive
 * agents only, and pointless once plan mode is already on.
 */
function addPlanModeTools(tools: ToolMap, opts: RunTurnOptions, allowed: AllowedTools): void {
    const target = { sessionId: opts.session.id, cwd: opts.cwd, abortSignal: opts.abortSignal };
    const planModeOn = isPlanModeActive(opts.session.id);
    const canSelfExitPlanMode = planModeOn && isUnrestricted(allowed) && getBashApprovalBridge() !== null;
    const namesPlanTool = !isUnrestricted(allowed) && allowed!.includes(PLAN_TOOL_NAME);
    if (namesPlanTool || (planModeOn && !canSelfExitPlanMode)) tools[PLAN_TOOL_NAME] = createPlanTool();
    if (canSelfExitPlanMode) tools[EXIT_PLAN_MODE_TOOL_NAME] = createExitPlanModeTool(target);
    if (isUnrestricted(allowed) && !planModeOn && getBashApprovalBridge()) {
        tools[ENTER_PLAN_MODE_TOOL_NAME] = createEnterPlanModeTool(target);
    }
}

/**
 * TurnContext carries which agent/model/tools are running. It's handed to
 * every turn-middleware seam (so an extension can scope by ctx.agent) and to
 * tool call/result middleware. Refreshed after onAssembleTools so its tool
 * list reflects any additions/removals.
 */
async function finishAssembly(
    tools: ToolMap,
    opts: RunTurnOptions,
    extra: TurnToolInputs,
): Promise<{ toolsForTurn: ToolMap; turnContext: TurnContext }> {
    const turnContext: TurnContext = {
        sessionId: opts.session.id,
        transcriptPath: opts.session.path,
        cwd: opts.cwd,
        agent: opts.agent ?? "default",
        modelId: opts.modelId,
        provider: extra.provider,
        model: extra.modelShortId,
        tools: Object.keys(tools),
        isSubagent: false,
        // Filled in once the context estimate runs; see TurnContext.contextUsed.
        contextWindow: 0,
    };
    const toolsForTurn = await applyAssembleTools(tools, turnContext);
    return { toolsForTurn, turnContext: { ...turnContext, tools: Object.keys(toolsForTurn) } };
}
