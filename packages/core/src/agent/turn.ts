/**
 * runTurn — the main agent loop: one user input driven to completion through
 * streaming, tools, hooks, persistence, and billing. The provider-shaping and
 * per-step accrual it shares with runSubagent live in model-call.ts.
 */
import { streamText, isStepCount, type ModelMessage } from "ai";
import { toolInputDeltaEvent, toolInputStartEvent, type TurnEmitter } from "./events";
import { getModel, parseModelId } from "../providers";
import { getCatalog } from "../catalog";
import { getSetting } from "../settings";
import {
    ARTIFACT_TOOL_NAME,
    createArtifactTool,
    createAskTool,
    createEnterPlanModeTool,
    createExitPlanModeTool,
    createPlanTool,
    createSkillTool,
    createTodoNudger,
    createTodoTool,
    createTools,
    createWebsearchTool,
    ENTER_PLAN_MODE_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    getBashApprovalBridge,
    getSessionTodos,
    isAskUserAvailable,
    isPlanModeActive,
    planDeliveredThisStep,
    PLAN_TOOL_NAME,
    formatShellNotices,
    SHELLS_TOOL_NAME,
    takeShellNotices,
    SKILL_TOOL_NAME,
    TODO_TOOL_NAME,
    createMcpResourceTool,
    MCP_RESOURCE_TOOL_NAME,
    buildMcpToolSearchNote,
    createMcpToolsTool,
    MCP_TOOLS_TOOL_NAME,
} from "../tools";
import {
    buildBackgroundShellsNote,
    buildPlanModeNote,
    buildMcpInstructionsNote,
    buildSubagentNote,
    buildSystemPrompt,
    buildTodoNote,
} from "./system-prompt";
import { getAgentPrompt, getAgentTools, isReadOnlyBashAgent, listAgents } from "./agents";
import { loadWorkspaceContext } from "./context";
import { loadMemoryContext } from "./memory";
import { formatSkillsForPrompt, loadProjectSkills, type Skill } from "./skills";
import { extractImagesFromInput, filterAttachmentsByModalities } from "./images";
import { CostTracker, stampUsageCost } from "./cost";
import { runCompact } from "./compact";
import {
    clearContextBoundary,
    decideContextAction,
    setActiveBranch,
    setContextBudget,
    takeContextBoundary,
} from "./context-policy";
import { buildRolloverHandoff, MAX_HANDOFF_CHARS as MAX_EXPLICIT_HANDOFF_CHARS, MIN_USABLE_TOKENS } from "./rollover";
import { runRecap, turnDeservesRecap } from "./recap";
import { cancelRecap, scheduleRecap } from "./recap-schedule";
import { runHooks, type HookOutcome } from "./hooks";
import { isTrusted } from "./trust";
import type { ThinkingLevel } from "./thinking";
import { estimateContextTokens, estimateOverheadTokens, toModelMessages, withAnthropicCaching } from "./model-messages";
import { buildAgentCallConfig, createStepBilling, createYieldGate } from "./model-call";
import { withToolHooks } from "./tool-hooks";
import { createTaskTool } from "./subagent";
import { isAbortError } from "./abort";
import {
    abortableDelay,
    DEFAULT_MAX_STREAM_RESUMES,
    describeRetry,
    isRetryableStreamError,
    resumeDelayMs,
} from "./retry";
import { debugLog } from "../debug";
import { getMcpManager, isMcpEnabled, shouldUseToolSearch } from "../mcp";
import { getExtensionHost } from "../extensions";
import type { TurnContext } from "../extensions/api";
import {
    applyAdditionalContext,
    applyAssembleTools,
    applyProviderOptions,
    applySystemPrompt,
    runAfterTurn,
    runBeforeTurn,
} from "./turn-middleware";
import { attachLedgerEntry, type Session } from "../sessions";
import type { UsageBlock } from "../types";
import { StepTimingRecorder, type SdkStepTimingFields } from "./step-timing";

export interface RunTurnOptions {
    session: Session;
    modelId: string;
    userInput: string;
    cwd: string;
    abortSignal?: AbortSignal;
    tracker: CostTracker;
    emitter: TurnEmitter;
    maxSteps?: number;
    thinkingLevel?: ThinkingLevel;
    /** Named agent whose prompt replaces the built-in persona ("default" = built-in). */
    agent?: string;
    /** Post-turn data-recap generation. Defaults to the `recap` setting (off). */
    recap?: boolean;
    /** internal: recursion depth for Stop-hook continuations */
    hookDepth?: number;
}

// AI SDK prints advisory warnings (e.g. about system messages inside the
// messages array — our deliberate Anthropic prompt-caching pattern) straight
// to the console, which tears the TUI's differential rendering. Silence them.
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

interface PersistedTurnMessage {
    role: "assistant" | "tool";
    content: unknown;
    usage?: UsageBlock;
}

/**
 * Turn one completed step's messages into session entries — assistant text +
 * tool calls, and the tool results — in canonical AI-SDK shape (so they replay
 * and feed straight back to the model). mirrors the reference: one entry per message,
 * persisted as the step finishes (abort-safe — completed steps survive).
 *
 * Task (subagent) tool calls/results are filtered out: they persist separately
 * as `subagent` entries (with their activity log), and keeping them here too
 * would double them on resume and in the model context.
 *
 * Per-step usage rides the step's assistant message: resume seeding sums
 * assistant usages (= turn total) and reads the last for context size.
 */
export function stepMessagesToEntries(
    messages: ReadonlyArray<{ role: string; content: unknown }>,
    stepUsage: UsageBlock | undefined,
): PersistedTurnMessage[] {
    // The ONLY thing held back is the `task` (subagent) call/result — and not
    // to drop data: the subagent is persisted MORE completely as its own
    // `subagent` entry (prompt + full internal activity log + report), so
    // letting it through here too would duplicate the box on resume. Every
    // other part — text, reasoning, tool calls, tool results — is persisted
    // exactly as it streamed.
    const taskCallIds = new Set<string>();
    const out: PersistedTurnMessage[] = [];
    // Resume-time cost seeding sums every usage-bearing assistant entry, so a
    // step's usage must ride exactly ONE of its messages — stamping each would
    // double-bill the step if the SDK ever emits two assistant messages per step.
    let usageToStamp = stepUsage;
    for (const m of messages) {
        if (m.role === "assistant") {
            const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
            const kept = parts.filter((p: { type?: string; toolName?: string; toolCallId?: string }) => {
                if (p?.type === "tool-call" && p.toolName === "task") {
                    if (p.toolCallId) taskCallIds.add(p.toolCallId);
                    return false;
                }
                return true;
            });
            if (kept.length > 0) {
                out.push({ role: "assistant", content: kept, usage: usageToStamp });
                usageToStamp = undefined;
            }
        } else if (m.role === "tool") {
            const parts = Array.isArray(m.content) ? m.content : [];
            const kept = parts.filter(
                (p: { toolCallId?: string }) => !(p?.toolCallId && taskCallIds.has(p.toolCallId)),
            );
            if (kept.length > 0) out.push({ role: "tool", content: kept });
        }
    }
    // A step whose assistant message was ONLY the task tool-call filters to
    // nothing — but its usage is still real billed tokens. Carry it on an
    // empty assistant entry: toModelMessages drops empty content, so it never
    // reaches the model, while resume cost seeding and /steak still count it.
    if (usageToStamp) out.push({ role: "assistant", content: [], usage: usageToStamp });
    return out;
}

/** Most recent provider-reported (non-estimated) usage in the transcript — the
 * input/cache profile to anchor an interrupted-step estimate to when the
 * current turn has no finished step yet (an interrupt on the very first step). */
function lastUsageInSession(session: Session): UsageBlock | undefined {
    const all = session.entries();
    for (let i = all.length - 1; i >= 0; i--) {
        const e = all[i];
        if (e.type === "message" && e.role === "assistant" && e.usage && !e.usage.estimated) return e.usage;
        if (e.type === "subagent" && e.usage && !e.usage.estimated) return e.usage;
    }
    return undefined;
}

/**
 * Estimate usage for the in-flight request of an interrupted turn. The AI SDK
 * records a step only on its `finish-step` chunk and reports no usage on abort
 * (vercel/ai#7805), so the cut-off round-trip has no provider numbers — yet the
 * provider billed it (input + the output streamed before the cut).
 *
 * Output is the only estimated part: the partial text + reasoning at chars/4
 * (loop's house heuristic; small, since an interrupt lands early). Input — the
 * expensive, cache-split-sensitive part — is NOT guessed: it's taken from the
 * adjacent real step (`basis`), since the interrupted request resent
 * essentially the same context, so its input count and cache-read/write split
 * match within a few hundred tokens. Marked `estimated` → session total only,
 * rendered with a leading `~`.
 */
function estimateInterruptedUsage(
    tailText: string,
    tailReasoning: string,
    basis: UsageBlock | undefined,
    session: Session,
    overheadTokens: number,
): UsageBlock | undefined {
    const textTokens = Math.ceil(tailText.length / 4);
    const reasoningTokens = Math.ceil(tailReasoning.length / 4);
    const outputTokens = textTokens + reasoningTokens;
    // No output streamed and no real basis to anchor to → fabricate nothing.
    if (outputTokens === 0 && !basis) return undefined;
    const inputTokens = basis?.inputTokens ?? estimateContextTokens(session, overheadTokens);
    const inputTokenDetails = basis?.inputTokenDetails ? { ...basis.inputTokenDetails } : undefined;
    const cachedInputTokens = basis?.inputTokenDetails?.cacheReadTokens ?? basis?.cachedInputTokens;
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens,
        inputTokenDetails,
        outputTokenDetails: { textTokens, reasoningTokens },
        estimated: true,
    };
}

/**
 * The turn's tool-assembly matrix: per-agent restriction, websearch/MCP/
 * extension/task/ask/plan gating (order matters — see each block), the
 * TurnContext handed to every middleware seam, and the extension
 * onAssembleTools pass. Returns the final toolset the model will see.
 */
async function assembleTurnTools(
    opts: RunTurnOptions,
    extra: { provider: string; modelShortId: string; workspaceContext: string; skillsPrompt: string; skills: Skill[] },
) {
    const { session, modelId, cwd, abortSignal, tracker, emitter } = opts;
    const agentPrompt = opts.agent ? getAgentPrompt(opts.agent) : undefined;
    // Per-agent tool restriction (e.g. plan = read-only). undefined = all tools.
    const allowedTools = opts.agent ? getAgentTools(opts.agent) : undefined;
    // An agent allowed bash but NOT write/edit (e.g. plan) gets bash forced into
    // a fail-closed read-only sandbox, so the kernel guarantees no mutation.
    const readOnlyFs = isReadOnlyBashAgent(allowedTools);
    const fullToolSet = createTools({ cwd, abortSignal, readOnlyFs, sessionId: session.id });
    const toolSet = (
        allowedTools?.length
            ? Object.fromEntries(Object.entries(fullToolSet).filter(([name]) => allowedTools.includes(name)))
            : fullToolSet
    ) as typeof fullToolSet;
    // Subagents: master `subagents` setting gates the task tool entirely (off
    // → no agent gets it). Otherwise unrestricted agents always get it;
    // restricted agents get it only when their tool list opts in ("task").
    // A subagent is a fork of this turn's agent by default; either way its
    // tools are capped to this turn's file tools, so delegation never widens
    // access. Subagents never get task themselves (no nesting).
    const subagentsEnabled = getSetting("subagents") !== false;
    let toolsForTurn: Record<string, unknown> = { ...toolSet };

    // Background shells: the opt-in `backgroundShells` setting (default off)
    // gates the whole capability. Off means the shells tool is not offered at
    // all — bash refuses run_in_background separately, so the model can neither
    // start one nor be handed a tool for reading shells that cannot exist.
    if (getSetting("backgroundShells") !== true) delete toolsForTurn[SHELLS_TOOL_NAME];

    // Websearch: opt-in `webSearch` setting (default off) — DuckDuckGo HTML
    // scraping, no API key, no UI bridge, so print mode gets it too. Added
    // BEFORE the task tool so subagents inherit it via parentTools (unlike
    // ask). Restricted agents opt in by naming "websearch".
    if (getSetting("webSearch") === true && (!allowedTools?.length || allowedTools.includes("websearch"))) {
        toolsForTurn.websearch = createWebsearchTool({ abortSignal });
    }

    // Artifacts: opt-in `artifacts` setting (default off). Publishes a file the
    // agent wrote with the ordinary write tool, so it is useless to an agent
    // that has no write tool — a restricted read-only agent like plan never
    // gets it, even by naming it. Added BEFORE the task tool so a subagent
    // researching and drafting a report can publish its own result.
    if (
        getSetting("artifacts") === true &&
        (!allowedTools?.length || (allowedTools.includes(ARTIFACT_TOOL_NAME) && allowedTools.includes("write")))
    ) {
        toolsForTurn[ARTIFACT_TOOL_NAME] = createArtifactTool({ abortSignal, sessionId: session.id });
    }

    // MCP tools (already namespaced mcp__server__tool) join the turn for
    // unrestricted agents only — a restricted agent (e.g. plan) keeps its
    // explicit allowlist. Gated by the master `mcp` setting (default on) +
    // project trust, mirroring skills/subagents. The manager was connected once
    // at startup; here we just read its aggregated tool set.
    //
    // Added BEFORE the task tool so MCP names land in `parentTools` — a subagent
    // fork then inherits the same MCP tools, while the resolver's cap still lets
    // a named subagent only narrow, never widen.
    // Not trust-gated here: the manager already decided which servers were
    // allowed to connect in this folder (user-scope always, project-scope only
    // when trusted), so anything it holds tools for has passed that test.
    const mcpEnabled = isMcpEnabled();
    if (mcpEnabled && !allowedTools?.length) {
        const mcp = getMcpManager();
        const mcpTools = mcp.getTools();
        const mcpToolCount = Object.keys(mcpTools).length;
        if (shouldUseToolSearch(mcpToolCount)) {
            // The tools are NOT advertised; mcp_tools reaches them by name.
            // Read through a callback rather than captured, so a server that
            // connects or drops mid-turn is reflected on the next call.
            toolsForTurn[MCP_TOOLS_TOOL_NAME] = createMcpToolsTool({ tools: () => getMcpManager().getTools() }) as never;
        } else {
            Object.assign(toolsForTurn, mcpTools);
        }
        // The resource reader rides along only when a connected server
        // actually publishes resources: a tools-only setup (which is most of
        // them) should not pay a tool slot to be told there is nothing to read.
        if (mcp.listResources().length > 0 || mcp.listResourceTemplates().length > 0) {
            toolsForTurn[MCP_RESOURCE_TOOL_NAME] = createMcpResourceTool({
                listResources: () => mcp.listResources(),
                listResourceTemplates: () => mcp.listResourceTemplates(),
                readResource: (server, uri) => mcp.readResource(server, uri),
            }) as never;
        }
    }

    // Extension tools — same gating as MCP: unrestricted agents only (a
    // restricted agent like plan keeps its explicit allowlist), trust-gated.
    // With no extensions loaded both maps are empty, so this is a no-op and the
    // turn's toolset is byte-for-byte the builtin set. `default` (unrestricted)
    // therefore gets every extension tool automatically; removals drop builtins
    // an extension explicitly overrode.
    if (!allowedTools?.length && isTrusted(cwd)) {
        const ext = getExtensionHost().getTools();
        for (const [name, tool] of ext.add) toolsForTurn[name] = tool as never;
        for (const name of ext.remove) delete toolsForTurn[name];
    }

    if (subagentsEnabled && (!allowedTools?.length || allowedTools.includes("task"))) {
        toolsForTurn.task = createTaskTool({
            modelId,
            cwd,
            tracker,
            emitter,
            abortSignal,
            session,
            sessionId: session.id,
            transcriptPath: session.path,
            turnAgent: opts.agent,
            // Everything the parent can call (incl. MCP); task isn't added yet,
            // so it can't recurse into itself.
            parentTools: Object.keys(toolsForTurn),
            workspaceContext: extra.workspaceContext,
            skillsPrompt: extra.skillsPrompt,
        });
    }
    // Skill tool: explicit skill invocation — attached whenever this turn has
    // visible skills (same `skills` setting + trust gate that loaded them; no
    // setting of its own). Added AFTER the task tool so subagents never
    // inherit it — their skills prompt keeps the read-tool wording, and the
    // read path stays a working fallback everywhere. Restricted agents opt in
    // by naming "skill". runTurn checks for this tool post-assembly to pick
    // the viaTool prompt wording.
    const visibleSkills = extra.skills.filter((s) => !s.disableModelInvocation);
    if (visibleSkills.length > 0 && (!allowedTools?.length || allowedTools.includes(SKILL_TOOL_NAME))) {
        toolsForTurn[SKILL_TOOL_NAME] = createSkillTool({ skills: visibleSkills });
    }
    // Todo tool: opt-in visible checklist for multi-step turns (todos setting,
    // default OFF). No UI bridge needed — in print mode the update just logs as
    // a tool call. Added AFTER the task tool so subagents never inherit it:
    // parallel subagents rewriting one pinned panel would fight the parent.
    if (getSetting("todos") === true && (!allowedTools?.length || allowedTools.includes(TODO_TOOL_NAME))) {
        toolsForTurn[TODO_TOOL_NAME] = createTodoTool({ sessionId: session.id, session, emitter });
    }
    // Ask tool: opt-in `askUser` setting (default off) AND a live interactive
    // UI bridge (registered by the CLI at startup; absent in print mode, so
    // the tool is never offered there). Restricted agents opt in by naming
    // "ask" in their tool list. Added AFTER the task tool so subagents never
    // inherit it via parentTools.
    const askEnabled = getSetting("askUser") === true && isAskUserAvailable();
    if (askEnabled && (!allowedTools?.length || allowedTools.includes("ask"))) {
        toolsForTurn.ask = createAskTool({ abortSignal });
    }
    // A plan-mode session must always have exactly ONE way to deliver its
    // plan — two overlapping delivery tools just confuse the model. Which one
    // it gets depends on whether the agent could actually act on an approval:
    //
    //   exit_plan_mode — unrestricted agent + an approval bridge. The user
    //     approves mid-turn, the gate lifts, and this same agent implements
    //     the plan it just wrote, context intact. Does NOT stop the turn.
    //   plan — everyone else (the restricted plan builtin, custom read-only
    //     agents, print mode / RPC where nobody can be asked). Delivery stops
    //     the turn; the TUI's implement/talk follow-up hands it onward.
    const planModeOn = isPlanModeActive(session.id);
    const canSelfExitPlanMode = planModeOn && !allowedTools?.length && getBashApprovalBridge() !== null;
    // Plan-delivery tool: for restricted agents that name it (the plan
    // builtin does; custom agents opt in via frontmatter), and for any
    // plan-mode turn that can't self-exit. Added AFTER the task tool so
    // subagents don't inherit it. Its presence also arms the hasToolCall stop
    // condition below: calling plan ends the turn with the plan as its input.
    if ((allowedTools?.length && allowedTools.includes(PLAN_TOOL_NAME)) || (planModeOn && !canSelfExitPlanMode)) {
        toolsForTurn[PLAN_TOOL_NAME] = createPlanTool();
    }
    // exit_plan_mode: agent-initiated exit, approval-gated — the mirror of
    // enter_plan_mode below and the reason plan mode is no longer a one-way
    // door for the agent.
    if (canSelfExitPlanMode) {
        toolsForTurn[EXIT_PLAN_MODE_TOOL_NAME] = createExitPlanModeTool({
            sessionId: session.id,
            cwd,
            abortSignal,
        });
    }
    // enter_plan_mode: agent-initiated plan mode, approval-gated. Unrestricted
    // agents only (a read-only agent has nothing to gain), interactive only
    // (needs the approval bridge; print mode / RPC never register one), and
    // pointless once plan mode is already on. Added AFTER the task tool so
    // subagents can't flip the parent session's mode.
    if (!allowedTools?.length && !planModeOn && getBashApprovalBridge()) {
        toolsForTurn[ENTER_PLAN_MODE_TOOL_NAME] = createEnterPlanModeTool({
            sessionId: session.id,
            cwd,
            abortSignal,
        });
    }
    // TurnContext carries which agent/model/tools are running. It's handed to
    // every turn-middleware seam (so an extension can scope by ctx.agent — e.g.
    // update one specific agent's system prompt) and to tool call/result
    // middleware. Built here, then refreshed after onAssembleTools so its tool
    // list reflects any additions/removals.
    let turnContext = {
        sessionId: session.id,
        transcriptPath: session.path,
        cwd,
        agent: opts.agent ?? "default",
        modelId,
        provider: extra.provider,
        model: extra.modelShortId,
        tools: Object.keys(toolsForTurn),
        isSubagent: false,
        // Filled in once the context estimate runs; see TurnContext.contextUsed.
        contextWindow: 0,
    };
    // Extension turn middleware may add/remove/wrap tools before the prompt is
    // built (so the tool list the model sees reflects any changes). No-op when no
    // extensions are loaded.
    toolsForTurn = await applyAssembleTools(toolsForTurn, turnContext);
    turnContext = { ...turnContext, tools: Object.keys(toolsForTurn) };
    return { toolsForTurn, fullToolSet, turnContext, agentPrompt };
}

export async function runTurn(opts: RunTurnOptions): Promise<void> {
    const { session, modelId, userInput, cwd, abortSignal, tracker, emitter } = opts;
    // Step cap is only an upper safety bound — the loop ends naturally when the
    // model returns no tool call. 0 / unset means "run until the model decides".
    const configuredSteps = opts.maxSteps ?? getSetting("maxSteps") ?? 0;
    const maxSteps = configuredSteps > 0 ? configuredSteps : Number.MAX_SAFE_INTEGER;

    // Extract attachment paths (images/PDFs) → ai-sdk file parts, keeping only
    // what this model's catalog modalities accept. Rejected paths go back into
    // the text so the reference reaches the model instead of vanishing.
    const extracted = extractImagesFromInput(userInput, cwd);
    const { allowed: images, rejected: rejectedAttachments } = filterAttachmentsByModalities(
        extracted.images,
        (await getCatalog())[modelId]?.modalities,
        modelId.split("/")[0],
    );
    let textWithoutPaths = extracted.textWithoutPaths;
    if (rejectedAttachments.length > 0) {
        // Keep the reference visible to the model — but only for paths the
        // cleanup actually removed (sentinel forms keep their token in text).
        const missing = rejectedAttachments.map((r) => r.path).filter((p) => !textWithoutPaths.includes(p));
        textWithoutPaths = [textWithoutPaths, ...missing].filter(Boolean).join("\n");
    }
    if (images.length > 0) {
        emitter.emit(
            "attached-images",
            images.map((i) => i.path),
        );
    }
    // UserPromptSubmit hooks: may block the turn or inject context for the
    // model. Skipped for Stop-hook continuations (hookDepth > 0) — those are
    // synthetic turns, and Claude Code doesn't fire UserPromptSubmit for them.
    const hookDepth = opts.hookDepth ?? 0;
    let promptHooks: HookOutcome = { block: false, messages: [], terminalSequences: [] };
    if (hookDepth === 0) {
        promptHooks = await runHooks(
            "UserPromptSubmit",
            undefined,
            { session_id: session.id, transcript_path: session.path, prompt: userInput },
            cwd,
        );
    }
    for (const m of promptHooks.messages) emitter.emit("hook-message", m);
    for (const s of promptHooks.terminalSequences) emitter.emit("hook-terminal-sequence", s);
    if (promptHooks.block) {
        emitter.emit("error", `prompt blocked by hook: ${promptHooks.reason}`);
        emitter.emit("finish", { usage: undefined });
        return;
    }

    // Extension turn middleware (onBeforeTurn) may block the turn. No-op when no
    // extensions are loaded.
    if (
        !(await runBeforeTurn({
            input: userInput,
            cwd,
            sessionId: session.id,
            agent: opts.agent ?? "default",
            modelId,
        }))
    ) {
        emitter.emit("error", "turn blocked by extension");
        emitter.emit("finish", { usage: undefined });
        return;
    }

    // The previous turn's recap, if one is still waiting or generating, dies
    // here — the user has answered, so it summarises something they have moved
    // past. Deliberately BEFORE the append below: it is the append that a late
    // recap would end up sorting after, so the window has to be shut first.
    cancelRecap(session.id);

    // Recovery tools (history) read conversation the model can no longer see,
    // so they need the branch itself, not the model-bound context.
    setActiveBranch(() => session.getBranch());

    // Persist user message verbatim (paths intact for reference in transcripts)
    await session.append({ type: "message", ts: Date.now(), role: "user", content: userInput });

    const { provider, model: modelShortId } = parseModelId(modelId);

    const catalog = await getCatalog();
    const modelInfo = catalog[modelId];

    const workspaceContext =
        getSetting("workspaceContext") !== false ? loadWorkspaceContext(cwd) : { text: "", files: [] };
    // Agent memory (default on): policy + MEMORY.md index for this project.
    // Main agent only — subagents don't get the write policy, so fan-out work
    // can't race duplicate memory writes.
    const memoryContext = getSetting("memory") !== false ? loadMemoryContext(cwd).text : "";
    // Project skills inject instructions into the prompt — gate on trust too.
    const skillsEnabled = getSetting("skills") !== false && isTrusted(cwd);
    const skills = skillsEnabled ? await loadProjectSkills(cwd) : { skills: [], diagnostics: [], promptBlock: "" };

    const assembled = await assembleTurnTools(opts, {
        provider,
        modelShortId,
        workspaceContext: workspaceContext.text,
        // Subagents get the read-tool wording (task tool forwards this): the
        // skill tool is parent-only, but skill files are readable everywhere.
        skillsPrompt: skills.promptBlock,
        skills: skills.skills,
    });
    const { toolsForTurn, fullToolSet, agentPrompt } = assembled;
    // Reassigned once the context estimate exists (see the threshold block).
    let turnContext: TurnContext = assembled.turnContext;
    // System prompt is built AFTER the task tool decision so the model's tool
    // list matches reality, plus explicit delegation guidance when present.
    const subagentNote = "task" in toolsForTurn ? buildSubagentNote(listAgents().map((a) => a.name)) : "";
    const todoNote = TODO_TOOL_NAME in toolsForTurn ? buildTodoNote() : "";
    const backgroundShellsNote = SHELLS_TOOL_NAME in toolsForTurn ? buildBackgroundShellsNote() : "";
    // Tell the model it is planning rather than letting it find out from a
    // rejected edit. Only when it can actually exit — everyone else is told by
    // the plan tool's own description.
    const planModeNote = EXIT_PLAN_MODE_TOOL_NAME in toolsForTurn ? buildPlanModeNote() : "";
    // Keyed off the assembled toolset, not the settings that produced it: a
    // restricted agent that was denied MCP tools — or an extension that removed
    // them in onAssembleTools — must not be told how to use tools it hasn't got.
    // Both notes are keyed off the ASSEMBLED toolset rather than the settings
    // that produced it, so an extension that dropped either surface in
    // onAssembleTools also silences the guidance for it.
    const mcpSearchMode = MCP_TOOLS_TOOL_NAME in toolsForTurn;
    const hasMcpTools = mcpSearchMode || Object.keys(toolsForTurn).some((name) => name.startsWith("mcp__"));
    const mcpInstructionsNote = hasMcpTools ? buildMcpInstructionsNote(getMcpManager().listServers()) : "";
    // A model shown one unfamiliar tool where it expected a server's tools
    // usually concludes the capability is missing rather than searching for it.
    const mcpToolSearchNote = mcpSearchMode
        ? buildMcpToolSearchNote(
              Object.keys(getMcpManager().getTools()).length,
              getMcpManager()
                  .listServers()
                  .filter((server) => server.status === "ready")
                  .map((server) => server.name),
          )
        : "";
    // Checked post-assembly (not re-derived from settings) so an extension
    // removing the skill tool in onAssembleTools also flips the wording back.
    const skillsBlock =
        SKILL_TOOL_NAME in toolsForTurn ? formatSkillsForPrompt(skills.skills, { viaTool: true }) : skills.promptBlock;
    let system =
        buildSystemPrompt({
            cwd,
            workspaceContext: workspaceContext.text,
            memoryContext,
            basePrompt: agentPrompt,
            tools: Object.keys(toolsForTurn),
        }) +
        subagentNote +
        todoNote +
        backgroundShellsNote +
        planModeNote +
        mcpToolSearchNote +
        mcpInstructionsNote +
        (skillsBlock ?? "");
    // Extension turn middleware may transform the system prompt, scoped by
    // ctx.agent (update any specific agent's prompt). No-op when none.
    system = await applySystemPrompt(system, turnContext);
    const tools = withToolHooks(toolsForTurn as typeof fullToolSet, {
        cwd,
        sessionId: session.id,
        transcriptPath: session.path,
        emitter,
        turnContext,
        // Empty when no extensions are loaded → withToolHooks is a pass-through.
        callMiddleware: getExtensionHost().getToolCallMiddleware(),
        resultMiddleware: getExtensionHost().getToolResultMiddleware(),
    });
    const model = await getModel(modelId);

    // Auto-compact check — runs here (not at turn start) so the estimate can
    // count the actual system prompt + tool definitions of THIS turn, which
    // never appear in the session but are billed context all the same.
    // Compaction only needs to land before toModelMessages() below; nothing
    // above reads the transcript.
    const contextOverheadTokens = estimateOverheadTokens(system, toolsForTurn);
    const threshold = getSetting("autoCompactThreshold") ?? 0.8;
    if (modelInfo) {
        const tokens = estimateContextTokens(session, contextOverheadTokens);
        // Usage is only knowable here — the estimate needs the overhead of the
        // final system prompt, which onSystemPrompt middleware just produced.
        // Anything reading it earlier undercounts by the whole system block.
        turnContext = { ...turnContext, contextUsed: tokens, contextWindow: modelInfo.contextWindow };
        const rolloverAt = Math.floor(modelInfo.contextWindow * threshold);
        setContextBudget({
            used: tokens,
            window: modelInfo.contextWindow,
            rolloverAt,
            supported: rolloverAt - contextOverheadTokens >= MIN_USABLE_TOKENS,
        });
        if (tokens > modelInfo.contextWindow * threshold) {
            const decision = await decideContextAction({
                session,
                modelId,
                cwd,
                usedTokens: tokens,
                contextWindow: modelInfo.contextWindow,
                overheadTokens: contextOverheadTokens,
                thresholdTokens: Math.floor(modelInfo.contextWindow * threshold),
                reason: "threshold",
            });
            if (decision.kind === "rollover") {
                // No model call, so no spend and nothing to abort — the entry is
                // the whole operation. Emitted through the same events as a
                // compaction so every surface keeps one code path.
                emitter.emit("compact-start", { reason: "auto", mode: "rollover" });
                await runHooks(
                    "PreCompact",
                    "auto",
                    { session_id: session.id, transcript_path: session.path, trigger: "rollover" },
                    cwd,
                );
                const before = tokens;
                await session.append({
                    type: "compact",
                    ts: Date.now(),
                    summary: "",
                    handoff: decision.handoff,
                    rollover: true,
                    cutAt: decision.cutAt,
                    tokensBefore: before,
                    tokensAfter: Math.ceil(decision.handoff.length / 4),
                });
                emitter.emit("compact-end", {
                    summary: "",
                    handoff: decision.handoff,
                    mode: "rollover",
                    cutAt: decision.cutAt,
                    tokensBefore: before,
                    tokensAfter: Math.ceil(decision.handoff.length / 4),
                });
            } else if (decision.kind === "summarize") {
            emitter.emit("compact-start", { reason: "auto" });
            // PreCompact is informational for watchers — block is ignored.
            await runHooks(
                "PreCompact",
                "auto",
                { session_id: session.id, transcript_path: session.path, trigger: "auto" },
                cwd,
            );
            try {
                const result = await runCompact({ session, modelId, abortSignal, tracker, cwd });
                emitter.emit("compact-end", result);
            } catch (err) {
                if (abortSignal?.aborted) {
                    emitter.emit("compact-end", {
                        summary: "",
                        cutAt: 0,
                        tokensBefore: 0,
                        tokensAfter: 0,
                        aborted: true,
                    });
                    // Every other early return emits finish — without it a
                    // finish-keyed consumer (an RPC client) waits forever.
                    emitter.emit("finish", { usage: undefined });
                    return;
                }
                throw err;
            }
            }
        }
    }

    // After the boundary decision, so a reminder reads the budget the fresh
    // window actually has rather than the one that triggered the rollover.
    const extensionContext = await applyAdditionalContext(turnContext);

    /**
     * The model-bound message array: the session's transcript plus the two
     * decorations that never belong in it (image parts, hook context).
     *
     * A function rather than a value because a resumed stream has to rebuild
     * it — the completed steps of the failed attempt are in the session by
     * then, and the decorations must land on the same last user message they
     * did the first time, or the prompt-cache prefix moves.
     */
    const buildMessages = (): ModelMessage[] => {
        // If we extracted image paths, override the last user message with a multipart
        // content array (text + image parts) so vision models actually see the image.
        const messages = toModelMessages(session);
        if (images.length > 0) {
            const lastUserIdx = (() => {
                for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
                return -1;
            })();
            if (lastUserIdx >= 0) {
                // AI SDK v6 user-content attachment shape: a `file` part with the
                // bytes as `data` and an IANA `mediaType`. (The older `image` part is
                // deprecated in favor of this for all attachment kinds.)
                const parts: Array<{ type: "text"; text: string } | { type: "file"; data: Buffer; mediaType: string }> =
                    [];
                if (textWithoutPaths) parts.push({ type: "text", text: textWithoutPaths });
                for (const img of images) parts.push({ type: "file", data: img.data, mediaType: img.mediaType });
                messages[lastUserIdx] = { role: "user", content: parts as never };
            }
        }

        // Hook-injected context rides only the model-bound copy, not the transcript.
        // Must target the *last* user message even when image extraction already
        // turned it into a parts array — falling through to an earlier message would
        // rewrite history and bust the prompt-cache prefix.
        // Extension-contributed context rides the same path: model-bound copy
        // only, on the last user message. Computed once above (async), so a
        // stream resume rebuilding messages reuses it rather than re-running
        // middleware mid-turn.
        const injected = [promptHooks.additionalContext, extensionContext].filter(Boolean).join("\n\n");
        if (injected) {
            const ctxBlock = `<hook-context>\n${injected}\n</hook-context>`;
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if (m.role !== "user") continue;
                if (typeof m.content === "string") {
                    messages[i] = { role: "user", content: `${m.content}\n\n${ctxBlock}` };
                } else if (Array.isArray(m.content)) {
                    messages[i] = { role: "user", content: [...m.content, { type: "text", text: ctxBlock }] as never };
                }
                break;
            }
        }
        return messages;
    };
    const messages = buildMessages();

    const thinkingLevel: ThinkingLevel = opts.thinkingLevel ?? getSetting("thinkingLevel") ?? "off";
    // Shared provider shaping (see model-call.ts): effective sdk mapping for
    // custom gateways, reasoning params, Anthropic caching + output-cap pin —
    // matching runSubagent by construction.
    const call = buildAgentCallConfig({ provider, modelShortId, thinkingLevel, modelInfo });
    let providerOptions = call.providerOptions;

    // Ollama defaults num_ctx to ~4096 regardless of the model's real context,
    // which truncates long agent loops and makes the model stop early. Pin it to
    // the model's actual context window so history isn't silently dropped.
    if (provider === "ollama") {
        const numCtx = modelInfo?.contextWindow ?? 8192;
        const existing = (providerOptions?.ollama as Record<string, unknown> | undefined) ?? {};
        const existingOpts = (existing.options as Record<string, unknown> | undefined) ?? {};
        providerOptions = {
            ...providerOptions,
            ollama: { ...existing, options: { ...existingOpts, num_ctx: numCtx } },
        };
    }

    // Extension turn middleware may tweak provider options (thinking/caching).
    // No-op when no extensions are loaded.
    providerOptions = applyProviderOptions(providerOptions, turnContext) as typeof providerOptions;

    // Todo staleness nudge (prepareStep seam): when the checklist has gone
    // unmaintained for many tool calls, append an ephemeral system-reminder to
    // the next request only — never persisted, so the prompt-cache prefix and
    // the transcript stay clean. Layered AFTER the caching prepareStep so the
    // cache breakpoint lands on stable history, with the nudge as uncached tail.
    const todoNudger = TODO_TOOL_NAME in toolsForTurn ? createTodoNudger(() => getSessionTodos(session.id)) : null;
    // Background shells announce their own exits on the same seam: a shell
    // that finished between steps is reported once, then cleared. Without it
    // "you will be told when it exits" is a promise the tool cannot keep, and
    // the model falls back to sleeping and polling.
    const shellNotices =
        SHELLS_TOOL_NAME in toolsForTurn ? () => formatShellNotices(takeShellNotices(session.id)) : null;
    const basePrepareStep = call.prepareStep;
    const prepareStep =
        todoNudger || shellNotices || basePrepareStep
            ? (opts: {
                  messages: ModelMessage[];
                  steps?: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: string }> }>;
              }) => {
                  let stepMessages = basePrepareStep
                      ? basePrepareStep({ messages: opts.messages }).messages
                      : opts.messages;
                  if (shellNotices) {
                      const notice = shellNotices();
                      if (notice) {
                          debugLog("shells", `exit notice injected (session ${session.id})`);
                          stepMessages = [...stepMessages, { role: "user", content: notice }];
                      }
                  }
                  if (todoNudger) {
                      const calls: string[] = [];
                      for (const s of opts.steps ?? []) {
                          for (const c of s.toolCalls ?? []) if (c.toolName) calls.push(c.toolName);
                      }
                      const nudge = todoNudger(calls);
                      if (nudge) {
                          debugLog("todo", `nudge injected after ${calls.length} tool calls (session ${session.id})`);
                          stepMessages = [...stepMessages, { role: "user", content: nudge }];
                      }
                  }
                  return { messages: stepMessages };
              }
            : undefined;

    // Incremental persistence: each completed step's messages are written as it
    // finishes, so tool calls/results AND the final answer survive turn
    // boundaries and aborts. `step.response.messages` holds only THIS step's new
    // messages — the AI SDK resets its per-step content buffer on every
    // `start-step`, so it is NOT cumulative. Persist all of them; there is no
    // overlap across steps to dedupe. (Slicing against a running count, on the
    // mistaken assumption it was cumulative, dropped every step after the first
    // — losing the final answer and its usage on reopen.)
    let persistedAnyMessage = false;
    // Per-step accrual (see model-call.ts): running sum for abort estimation,
    // and ledger rows billed at finish-step waiting for their entry's id so
    // the row can be attributed. One pending id per usage-bearing step;
    // persist and billing race per step, so an empty shift just skips
    // attribution (the money row itself is already safe).
    const billing = createStepBilling(tracker, modelId, { cwd, sessionPub: session.info.id, source: "turn" });
    // Serialize appends so each step's messages land in order even if onStepEnd
    // callbacks overlap.
    let persistChain: Promise<void> = Promise.resolve();
    // Filled by the stream loop's reasoning-start/end events; drained here in
    // the same order the parts appear in the step's messages.
    const reasoningDurations: number[] = [];
    // Wall clock per step for the trace view (see step-timing.ts). Fed by the
    // SDK's lifecycle callbacks below; read when a step is persisted.
    const timing = new StepTimingRecorder();

    const persistStep = (
        step: SdkStepTimingFields & {
            response: { messages: ReadonlyArray<{ role: string; content: unknown }> };
            usage?: UsageBlock;
        },
    ): Promise<void> => {
        const entries = stepMessagesToEntries(step.response.messages, step.usage);
        if (entries.length > 0) persistedAnyMessage = true;
        // Snapshot the durations for THIS step now (the queue keeps filling
        // while the async append below waits its turn in the chain).
        const stepReasoningMs = reasoningDurations.splice(0, reasoningDurations.length);
        // Likewise the timing: onStepEnd IS the step's end instant. It rides
        // on the step's assistant entry (the one whose content the model
        // produced in that window), never on the tool results.
        const stepTiming = timing.stepEnded(step);
        const timingEntry = entries.find((e) => e.role === "assistant");
        persistChain = persistChain
            .then(async () => {
                const rows = entries.map((entry) => {
                    // Display metadata: this entry's reasoning-part durations,
                    // in part order (see the Entry type for why not in content).
                    const reasoningMs = Array.isArray(entry.content)
                        ? stepReasoningMs.splice(
                              0,
                              (entry.content as Array<{ type?: string }>).filter((p) => p?.type === "reasoning").length,
                          )
                        : [];
                    return {
                        type: "message" as const,
                        ts: Date.now(),
                        role: entry.role,
                        content: entry.content,
                        ...(reasoningMs.length > 0 ? { reasoningMs } : {}),
                        ...(entry === timingEntry ? { timing: stepTiming } : {}),
                        // Stamp the model AND the billed USD on usage-bearing
                        // (assistant) entries so cost seeding reads the true
                        // historical cost after a model switch or catalog drift.
                        ...(entry.usage ? { usage: stampUsageCost(modelId, entry.usage), model: modelId } : {}),
                    };
                });
                // One batch = one transaction for the whole step's messages.
                await session.appendAll(rows);
                // appendAll assigned ids in place — attribute this step's
                // ledger row to the entry that carries its usage.
                const usageEntry = rows.find((r) => "usage" in r && r.usage) as { id?: string } | undefined;
                if (usageEntry?.id) {
                    const rowId = billing.rowIds.shift();
                    if (rowId !== undefined) attachLedgerEntry(rowId, usageEntry.id);
                }
            })
            // Persistence must never break a turn — but a failed transcript
            // write is data loss, so leave a breadcrumb (LOOP_DEBUG=1).
            .catch((err) => debugLog("persist", `step persistence failed for session ${session.id}:`, err));
        return persistChain;
    };
    /**
     * Open a stream over `attemptMessages`, with `remainingSteps` of the
     * turn's step budget left. Called once normally, and again per resume — a
     * resumed stream is a fresh call over the conversation the finished steps
     * left behind, not a replay.
     */
    const openStream = (attemptMessages: ModelMessage[], remainingSteps: number) =>
        streamText({
            model,
            ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
            ...(call.anthropicCaching
                ? // system inside messages is our deliberate Anthropic prompt-caching
                  // pattern — allowSystemInMessages opts out of the AI SDK warning.
                  {
                      messages: withAnthropicCaching(system, attemptMessages),
                      allowSystemInMessages: true,
                  }
                : { instructions: system, messages: attemptMessages }),
            // Caching tail-move and/or todo nudge — undefined when neither applies.
            ...(prepareStep ? { prepareStep } : {}),
            tools,
            // A plan-capable turn also stops once a substantial plan is delivered
            // (stub deliveries keep the loop alive — see planDeliveredThisStep).
            stopWhen:
                PLAN_TOOL_NAME in toolsForTurn
                    ? [isStepCount(remainingSteps), planDeliveredThisStep]
                    : isStepCount(remainingSteps),
            abortSignal,
            // v7 portable reasoning effort for first-party providers (off → "none").
            // Undefined for community providers / non-reasoning models, which use
            // providerOptions (or nothing) instead.
            ...(call.reasoning ? { reasoning: call.reasoning } : {}),
            // Persist each step's messages as it finishes (mirrors the reference's
            // per-message persistence). Errors here must not break the turn.
            onStepEnd: (step) => {
                void persistStep(step as never);
            },
            // Trace anchors. onStepStart is the only start instant we keep
            // ourselves — everything else comes as durations on the step result.
            onStepStart: () => timing.stepStarted(),
            onToolExecutionStart: (event) => {
                const call = (event as { toolCall?: { toolCallId?: string; toolName?: string } }).toolCall;
                if (call?.toolCallId) timing.toolStarted(call.toolCallId, call.toolName ?? "");
            },
            onToolExecutionEnd: (event) => {
                const e = event as { toolCall?: { toolCallId?: string }; toolOutput?: { type?: string } };
                if (e.toolCall?.toolCallId) timing.toolEnded(e.toolCall.toolCallId, e.toolOutput?.type === "tool-error");
            },
            // The SDK's default onError does console.error(error) with the whole
            // APICallError (request body, tool defs — a wall of noise). We already
            // surface stream errors cleanly via the stream "error" part below,
            // so swallow this duplicate to keep the console clean.
            onError: () => {},
            // smoothStream removed: it re-buffers tokens and releases them on its
            // own 20ms timers, coupling stream delivery to the timer phase — the
            // same phase that starves during a turn, which can deadlock delivery
            // and freeze the TUI. the reference doesn't use it; we stream parts raw.
            ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
        });

    let assistantText = "";
    const toolsUsed: string[] = [];
    let lastUsage: UsageBlock | undefined;
    let lastStepUsage: UsageBlock | undefined;
    // Text/reasoning streamed since the last FINISHED step (reset on each
    // finish-step). On abort this is the un-persisted tail of the interrupted
    // step — the only part not already saved/billed — used to recover its
    // partial output and estimate its cost.
    let textSinceStep = "";
    let reasoningSinceStep = "";
    // Wall clock per reasoning part (start→end), in stream order — stamped
    // onto the step's assistant entry as reasoningMs so "Thought for Xs"
    // survives resume. Consumed by persistStep in the same order.
    let reasoningStartedAt = 0;
    // The AI SDK skips its stream `finish` part on abort; track whether we
    // already forwarded one so RPC/web clients still get a single end event.
    let sawFinish = false;
    // Steps this turn has completed across every attempt — the resume budget
    // is what remains of maxSteps, so a resumed turn can't exceed the cap.
    let stepsDone = 0;
    // Set by the `error` case (and the catch below) when the failure looks
    // transient; cleared at the top of each attempt, so it always describes
    // the CURRENT attempt. Drives the resume decision once the stream ends,
    // and is the error reported if there is no attempt left — a failure we
    // then recovered from is never reported at all.
    let streamError: unknown;
    // A `finish` withheld because the stream ended on a retryable error —
    // emitted only if we end up giving up, so a resumed turn never tells its
    // consumers the turn ended and then keeps going.
    let pendingFinish: { usage?: UsageBlock } | undefined;

    const maybeYield = createYieldGate();
    // A turn may reopen its stream when a transient provider failure kills it
    // between steps. 0 disables (the old behaviour: first error ends the turn).
    const maxResumes = Math.max(0, getSetting("maxStreamResumes") ?? DEFAULT_MAX_STREAM_RESUMES);
    let attemptMessages = messages;
    let resumes = 0;

    // One iteration = one stream. The body below is the original consume loop;
    // everything it accumulates (text, tools, billing, usage) is deliberately
    // outer-scoped, so a resumed stream continues the same turn rather than
    // starting a new one.
    streamAttempts: for (;;) {
        streamError = undefined;
        const result = openStream(attemptMessages, Math.max(1, maxSteps - stepsDone));
        // The interrupt can land between parts (caught by the `break` below) or while
        // awaiting the next part. A real fetch-backed provider rejects its body
        // stream on abort, which can throw straight out of `for await`; without this
        // guard that throw would skip the persistence below, losing the partial
        // reply. Swallow only aborts; any other error still propagates.
        try {
            for await (const part of result.stream) {
                if (abortSignal?.aborted) break;
                // First output of the step in flight — only the abort path
                // reads this (finished steps get the SDK's own measurement).
                if (part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "tool-input-start") {
                    timing.outputSeen();
                }
                switch (part.type) {
                    case "text-delta":
                        assistantText += part.text;
                        textSinceStep += part.text;
                        emitter.emit("text-delta", part.text);
                        break;
                    case "reasoning-delta": {
                        const rt = (part as { text: string }).text;
                        reasoningSinceStep += rt;
                        emitter.emit("reasoning-delta", rt);
                        break;
                    }
                    case "reasoning-start":
                        reasoningStartedAt = Date.now();
                        emitter.emit("reasoning-start");
                        break;
                    case "reasoning-end":
                        reasoningDurations.push(Date.now() - (reasoningStartedAt || Date.now()));
                        emitter.emit("reasoning-end");
                        break;
                    case "tool-input-start":
                        // Surface the pending tool box as soon as the call begins,
                        // before its (possibly large) input has finished streaming.
                        // Field mapping lives in toolInputStartEvent — v7 renamed
                        // toolCallId → id on these parts and the old cast silently
                        // read undefined, suppressing the pending box entirely.
                        emitter.emit(
                            "tool-input-start",
                            toolInputStartEvent(part as { id?: string; toolName?: string }),
                        );
                        break;
                    case "tool-input-delta":
                        emitter.emit("tool-input-delta", toolInputDeltaEvent(part as { id?: string; delta?: string }));
                        break;
                    case "tool-call":
                        if (part.toolName) toolsUsed.push(part.toolName);
                        emitter.emit("tool-call", part);
                        break;
                    case "tool-result":
                        emitter.emit("tool-result", part);
                        break;
                    case "tool-error": {
                        // A tool's execute threw (MCP transport failure, timeout, bad
                        // args…). The AI SDK still feeds the error back to the model as
                        // the tool result, so the loop continues and the model can try
                        // another approach — we just surface it in the UI (red) instead
                        // of leaving the tool box spinning forever.
                        const e = part as { toolCallId?: string; toolName?: string; error?: unknown };
                        emitter.emit("tool-error", { toolCallId: e.toolCallId, toolName: e.toolName, error: e.error });
                        break;
                    }
                    case "finish-step": {
                        // The SDK closes a failed stream with a finish-step of its
                        // own (finishReason "error"). That is not a step the model
                        // completed: it produced nothing, it must not spend the
                        // step budget, and — the part that matters — it must not
                        // clear the un-persisted tail below, which is how the
                        // resume decision knows whether text was mid-flight.
                        if ((part as { finishReason?: string }).finishReason === "error") break;
                        // Cost accrues per step (one API round-trip each), not at turn
                        // end — the footer updates live, and an aborted turn keeps the
                        // cost of the steps that already ran. Step usages sum to the
                        // turn total, so nothing is added again on finish.
                        const u = (part as { usage?: UsageBlock }).usage;
                        if (u) {
                            lastStepUsage = u;
                            // Attribution handoff: persistStep attaches the queued
                            // row to the entry that carries the same usage once the
                            // entry has its id (persist and billing race per step;
                            // the queue tolerates either order).
                            const { breakdown } = billing.onStepUsage(u);
                            emitter.emit("step-usage", { usage: u, breakdown });
                        }
                        // This step's text/reasoning is now persisted via onStepEnd
                        // and billed via the usage above — reset the tail so it
                        // tracks only what streams in the NEXT (possibly aborted)
                        // step. Keeps multi-step aborts from re-persisting or
                        // double-counting finished text.
                        textSinceStep = "";
                        reasoningSinceStep = "";
                        // Counts across attempts: the resume budget is the
                        // remainder of maxSteps, never a fresh allowance.
                        stepsDone++;
                        break;
                    }
                    case "finish": {
                        const u = (part as { totalUsage?: UsageBlock }).totalUsage;
                        lastUsage = u;
                        // The SDK ends a failed stream with a finish too. Announcing
                        // the turn's end here would be a lie if we are about to
                        // reopen it — and `finish` is terminal for RPC/web clients.
                        // Hold it; the resume decision either continues (no finish)
                        // or gives up and emits it after the error.
                        if ((part as { finishReason?: string }).finishReason === "error" && streamError !== undefined) {
                            pendingFinish = { usage: u };
                            break;
                        }
                        sawFinish = true;
                        emitter.emit("finish", { usage: u, lastStepUsage });
                        break;
                    }
                    case "error": {
                        const msg = String((part as { error?: unknown }).error ?? "");
                        if (/^(reasoning|text) part .* not found$/.test(msg)) break;
                        // Hold a transient failure back: the stream is about to end
                        // either way, and if the resume succeeds the user never
                        // needed to see it. Anything else is reported immediately,
                        // exactly as before.
                        if (isRetryableStreamError(part.error)) streamError = part.error;
                        else emitter.emit("error", part.error);
                        break;
                    }
                }
                // Let the TUI's render timers fire between bursts of buffered
                // parts — see model-call.ts for the starvation rationale.
                await maybeYield();
            }
        } catch (err) {
            // A transport failure can throw straight out of the iteration
            // instead of arriving as an error part — same decision either way.
            if (isAbortError(err) || abortSignal?.aborted) {
                // fall through: abort is handled below, never retried
            } else if (isRetryableStreamError(err)) {
                streamError = err;
            } else throw err;
        }

        // ---- resume decision -------------------------------------------------
        // Reopen the stream only when the failure landed BETWEEN steps: the
        // finished steps are persisted, so a fresh stream over them continues
        // the turn. With an un-persisted tail in flight, the model would
        // regenerate that step and the user would see the text twice — so that
        // case reports the error instead, which is what always happened.
        const tailInFlight = textSinceStep !== "" || reasoningSinceStep !== "";
        const canResume =
            streamError !== undefined &&
            !sawFinish &&
            !abortSignal?.aborted &&
            !tailInFlight &&
            resumes < maxResumes &&
            stepsDone < maxSteps;
        if (!canResume) {
            // Report only THIS attempt's failure. A held-back error from an
            // earlier attempt that we then recovered from is not news — the
            // turn went on to finish.
            if (streamError !== undefined) emitter.emit("error", streamError);
            // Then the finish we withheld, so a finish-keyed consumer (an RPC
            // client) still sees exactly one end event.
            if (pendingFinish && !sawFinish) {
                sawFinish = true;
                emitter.emit("finish", { usage: pendingFinish.usage, lastStepUsage });
            }
            break streamAttempts;
        }
        pendingFinish = undefined;
        resumes++;
        emitter.emit("stream-retry", {
            attempt: resumes,
            max: maxResumes,
            reason: describeRetry(streamError),
            stepsDone,
        });
        debugLog("retry", `stream failed after ${stepsDone} step(s), resume ${resumes}/${maxResumes}`);
        // Let the finished steps land before rebuilding the conversation from
        // them — otherwise the resumed stream re-asks the last question.
        await persistChain;
        const waitFrom = Date.now();
        await abortableDelay(resumeDelayMs(resumes - 1), abortSignal);
        timing.retryWaited(Date.now() - waitFrom);
        if (abortSignal?.aborted) break streamAttempts;
        attemptMessages = buildMessages();
    }

    // Flush any in-flight step persistence before deciding on the fallback /
    // returning, so the session file is complete and ordered.
    await persistChain;

    const aborted = abortSignal?.aborted === true;

    // The un-persisted tail: reasoning + text streamed since the last FINISHED
    // step. Finished steps already persisted (onStepEnd) and billed (finish-step
    // usage) their own content, so this is exactly the interrupted step's
    // partial output — nothing finished is lost or duplicated. Reasoning is kept
    // (an interrupt during the thinking phase still records what it produced)
    // and the answer text after it; both also count toward the cost estimate.
    const tailParts: Array<{ type: "reasoning"; text: string } | { type: "text"; text: string }> = [];
    if (reasoningSinceStep.trim() !== "") tailParts.push({ type: "reasoning", text: reasoningSinceStep });
    if (textSinceStep.trim() !== "") tailParts.push({ type: "text", text: textSinceStep });
    const streamedTail = tailParts.length > 0;

    if (aborted) {
        // Estimate the interrupted in-flight request's usage — the SDK reports
        // none on abort (vercel/ai#7805). Only when output actually streamed in
        // an unfinished step: a clean step-boundary interrupt left every
        // finished step already billed via finish-step, so there's nothing to
        // add. Input is anchored to the adjacent real step (this turn's last, or
        // the previous turn's); only the small output tail is approximated.
        // Session total only (never the persistent cost store), shown with `~`.
        let est: UsageBlock | undefined;
        if (streamedTail) {
            est = estimateInterruptedUsage(
                textSinceStep,
                reasoningSinceStep,
                lastStepUsage ?? lastUsageInSession(session),
                session,
                contextOverheadTokens,
            );
            if (est) {
                tracker.addEstimated(modelId, est, { cwd, sessionPub: session.info.id, source: "turn" });
                emitter.emit("step-usage", { usage: est, breakdown: tracker.sessionBreakdown() });
            }
        }
        // Persist the interrupted turn so the transcript AND the next turn's
        // context both reflect it. `interrupted: true` makes toModelMessages
        // append a note (and never silently drop an empty aborted turn). Only
        // text/usage here — never tool-call parts (those persist on finished
        // steps only), so there's no orphaned tool_use to break the next turn.
        if (streamedTail || !persistedAnyMessage) {
            const inFlight = timing.closeInFlight();
            const interruptedEntry = {
                type: "message" as const,
                ts: Date.now(),
                role: "assistant" as const,
                content: tailParts.length > 0 ? tailParts : "",
                interrupted: true,
                ...(inFlight ? { timing: inFlight } : {}),
                ...(est ? { usage: stampUsageCost(modelId, est), model: modelId } : {}),
            };
            await session.append(interruptedEntry);
            const estRowId = tracker.takeLastLedgerRowId();
            if (est && estRowId !== undefined && (interruptedEntry as { id?: string }).id) {
                attachLedgerEntry(estRowId, (interruptedEntry as { id?: string }).id!);
            }
        }
        // The AI SDK skips its stream `finish` part on abort (see model-call.ts).
        // RPC/web clients clear "running" on finish — without this, Stop looks
        // broken and the composer stays locked. TUI finishAssistant is idempotent.
        if (!sawFinish) {
            sawFinish = true;
            emitter.emit("finish", { usage: undefined, lastStepUsage });
        }
    } else if (!persistedAnyMessage && (tailParts.length > 0 || lastUsage || billing.sum)) {
        // Non-abort edge: the stream ended without any step persisting (e.g. a
        // provider error after partial output). Keep what streamed, with the
        // real usage we did capture.
        const edgeUsage = lastUsage ?? billing.sum;
        const inFlight = timing.closeInFlight();
        await session.append({
            type: "message",
            ts: Date.now(),
            role: "assistant",
            content: tailParts.length > 0 ? tailParts : "",
            ...(inFlight ? { timing: inFlight } : {}),
            usage: edgeUsage ? stampUsageCost(modelId, edgeUsage) : undefined,
            model: modelId,
        });
    }

    // An explicit new_context lands HERE, not at persistChain: the interrupt
    // and stream-edge entries above still append after that point, and a
    // boundary committed before them would compute cutAt against an incomplete
    // message list — leaving this turn's own final assistant message stranded
    // above its own boundary. An aborted turn drops the request instead: the
    // user pressed Ctrl+C, and throwing away their context is not what they
    // asked for. The model can ask again next turn.
    const boundary = takeContextBoundary();
    if (boundary) {
        if (abortSignal?.aborted) {
            clearContextBoundary();
        } else {
            const messageCount = session.messages().length;
            const handoff =
                boundary.handoff?.trim() ||
                buildRolloverHandoff(session.getBranch(), { limit: MAX_EXPLICIT_HANDOFF_CHARS }) ||
                "";
            if (handoff) {
                emitter.emit("compact-start", { reason: "manual", mode: "rollover" });
                await session.append({
                    type: "compact",
                    ts: Date.now(),
                    summary: "",
                    handoff,
                    rollover: true,
                    cutAt: messageCount,
                    tokensBefore: estimateContextTokens(session, contextOverheadTokens),
                    tokensAfter: Math.ceil(handoff.length / 4),
                });
                emitter.emit("compact-end", {
                    summary: "",
                    handoff,
                    mode: "rollover",
                    cutAt: messageCount,
                    tokensBefore: estimateContextTokens(session, contextOverheadTokens),
                    tokensAfter: Math.ceil(handoff.length / 4),
                });
            }
        }
    }

    // Post-turn recap: only for turns that wrote/edited files, detached so the
    // prompt frees immediately. It does NOT start here — it waits out
    // RECAP_DELAY_MS and the next turn cancels it (see recap-schedule.ts), so
    // a user who replies straight away never pays for a summary of the turn
    // they just moved past. Skipped for hook continuations (the final
    // continuation recaps the whole turn).
    const recapEnabled = opts.recap ?? getSetting("recap") === true;
    const recapWorthy = turnDeservesRecap(toolsUsed) && assistantText.trim() !== "";
    if (recapEnabled && recapWorthy && hookDepth === 0 && !abortSignal?.aborted) {
        scheduleRecap(session.id, async (signal) => {
            // The recap's own signal, not the turn's: the turn is over by the
            // time this runs, and what must be able to cancel it now is the
            // NEXT turn starting.
            const text = await runRecap({
                session,
                modelId,
                userInput,
                assistantText,
                toolsUsed,
                tracker,
                cwd,
                abortSignal: signal,
            }).catch(() => ""); // best-effort — a failed recap never fails the turn
            if (text && !signal.aborted) emitter.emit("data-recap", { text });
        });
    }

    // Stop hooks: a block sends the reason back as a follow-up turn so the
    // agent keeps working (Claude Code parity, e.g. "tests must pass"). Depth
    // capped to avoid infinite hook loops.
    if (!abortSignal?.aborted) {
        // stop_hook_active mirrors Claude Code: true when this turn is already a
        // stop-hook continuation, so ported hooks can use it as their loop guard.
        const stopHooks = await runHooks(
            "Stop",
            undefined,
            {
                session_id: session.id,
                transcript_path: session.path,
                stop_hook_active: hookDepth > 0,
                // Beyond Claude Code's payload: what the agent actually said.
                // Every "the turn is done" watcher wants to show it (cmux's
                // completion notification is one), and reading it back out of
                // the transcript to find that out is absurd when the turn is
                // holding the text right here. Capped — this rides a stdin
                // pipe to every configured Stop hook.
                last_assistant_message: assistantText.trim().slice(0, 4_000) || undefined,
            },
            cwd,
        );
        for (const m of stopHooks.messages) emitter.emit("hook-message", m);
        for (const s of stopHooks.terminalSequences) emitter.emit("hook-terminal-sequence", s);
        if (stopHooks.block && hookDepth < 3) {
            emitter.emit("hook-message", `stop hook requested continuation: ${stopHooks.reason}`);
            await runTurn({ ...opts, userInput: `[stop hook] ${stopHooks.reason}`, hookDepth: hookDepth + 1 });
        }
    }

    // Extension turn middleware (onAfterTurn) — best-effort, never fails a turn.
    // No-op when no extensions are loaded.
    await runAfterTurn(turnContext);
}
