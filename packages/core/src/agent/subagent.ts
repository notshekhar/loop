/**
 * Subagents — the task tool runs a nested agent loop (own context window,
 * own toolset from the chosen agent). Streaming surfaces through the parent
 * emitter (subagent-delta / subagent-tool / subagent-finish, keyed by the
 * task toolCallId) and usage aggregates into the parent's CostTracker.
 * Completed runs persist as `subagent` session entries so resumes keep the
 * task box, its report, and its cost.
 */
import { isStepCount, tool, ToolLoopAgent } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { TurnEmitter } from "./events";
import { getModel, parseModelId } from "../providers";
import { getCatalog } from "../catalog";
import { anthropicCachedSystem } from "./model-messages";
import { buildAgentCallConfig, createStepBilling, createYieldGate } from "./model-call";
import { getSetting } from "../settings";
import { createTools, createMcpResourceTool, MCP_RESOURCE_TOOL_NAME } from "../tools";
import { getMcpManager } from "../mcp";
import { getExtensionHost } from "../extensions";
import { attachLedgerEntry, type Session } from "../sessions";
import type { Entry, SubagentActivityPart, UsageBlock } from "../types";
import { buildSystemPrompt } from "./system-prompt";
import {
    agentExists,
    DEFAULT_AGENT_NAME,
    getAgentModel,
    getAgentPrompt,
    getAgentTools,
    isReadOnlyBashAgent,
    listAgents,
} from "./agents";
import { runHooks } from "./hooks";
import { withToolHooks } from "./tool-hooks";
import { stampUsageCost, type CostTracker } from "./cost";

const SUBAGENT_SYSTEM_SUFFIX = `

You are a subagent launched by a main agent. Rules of the run:
- Work autonomously — there is no user to ask; resolve ambiguity with the most reasonable reading of the prompt and state which reading you chose.
- If the prompt contains NO actionable task — only a path, a name, or a fragment with no instruction — do NOT invent one. Stop immediately and reply: "The task prompt contains no instruction — re-issue the task stating exactly what to find or do." Guessing at an unstated task wastes the entire run.
- Stay on the given task. Do not expand scope or touch anything the prompt didn't cover.
- Be economical while investigating: take the shortest path to the answer. Don't repeat searches, or exhaustively sweep directories when targeted reads suffice. Stop the moment you can answer — every extra step costs real money and delays the main agent.
- Only your final message returns to the main agent — it is their only window into your work. Write like the main agent would: lead with the outcome, then the insight needed to understand and act (exact paths, names, key findings, conclusions, evidence, surprises). Be precise and concise for what was asked — complete enough that the main agent need not redo your investigation, but no padding and no play-by-play of what you tried.
- If you cannot finish, report exactly how far you got and what blocked you; a precise partial report beats a vague complete-sounding one.`;

/**
 * Concurrency gate for parallel task calls. The AI SDK executes every tool
 * call of a step concurrently, so a model that fans out N tasks opens N
 * provider streams at once — the semaphore caps how many actually run;
 * the rest wait their turn (announced in their task box). FIFO so a queued
 * task can't starve.
 */
export class Semaphore {
    private running = 0;
    private waiters: Array<() => void> = [];
    /** limit <= 0 = unlimited. */
    constructor(private readonly limit: number) {}

    /** Take a slot if one is free right now. */
    tryAcquire(): boolean {
        if (this.limit <= 0 || this.running < this.limit) {
            this.running++;
            return true;
        }
        return false;
    }

    /**
     * Wait for a slot. An abort resolves the wait immediately (the caller
     * checks the signal and unwinds through its own release), so a queued
     * task never outlives an Esc.
     */
    async acquire(signal?: AbortSignal): Promise<void> {
        if (this.tryAcquire()) return;
        await new Promise<void>((resolve) => {
            const waiter = () => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            };
            const onAbort = () => {
                const i = this.waiters.indexOf(waiter);
                if (i >= 0) this.waiters.splice(i, 1);
                resolve();
            };
            this.waiters.push(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
        this.running++;
    }

    release(): void {
        this.running = Math.max(0, this.running - 1);
        this.waiters.shift()?.();
    }

    get queued(): number {
        return this.waiters.length;
    }
}

/** One-line summary of a tool call's input for the activity log (` arg`, capped). */
export function subagentArgSummary(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const a = input as Record<string, unknown>;
    const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.prompt;
    if (typeof v !== "string" || !v) return "";
    const one = v.split("\n")[0];
    return ` ${one.length > 70 ? `${one.slice(0, 67)}…` : one}`;
}

export interface SubagentCtx {
    modelId: string;
    cwd: string;
    tracker: CostTracker;
    emitter: TurnEmitter;
    abortSignal?: AbortSignal;
    session: Session;
    sessionId: string;
    transcriptPath: string;
    /** Agent active for this turn (session agent or one-shot /<agent>) — the
     * subagent is a fork of it unless the task call names another agent. */
    turnAgent?: string;
    /** Parent's effective file-tool names. Always the cap on what a subagent
     * may use: a fork inherits exactly the parent's tools, and a named
     * override is intersected with them — delegation never widens access. */
    parentTools: string[];
    /** Parent's workspace context (CLAUDE.md etc.) — a fork sees the same rules. */
    workspaceContext?: string;
    /** Parent's skills prompt block. */
    skillsPrompt?: string;
}

export function createTaskTool(ctx: SubagentCtx) {
    const agentNames = listAgents()
        .map((a) => a.name)
        .join(", ");
    // One gate per turn: fan-out within a step shares it, so at most
    // subagentMaxParallel provider streams run at once (default 4).
    const gate = new Semaphore(getSetting("subagentMaxParallel") ?? 4);
    return tool({
        description:
            "Launch a subagent to handle a self-contained task and return its final report. " +
            "Use for context-heavy or parallelizable work (broad searches, analysis, multi-file changes) " +
            "to keep the main context small. By default the subagent is a fork of you — same prompt and " +
            "tools (minus task), fresh context window. " +
            "The subagent starts blank: it sees none of this conversation, only the prompt you write. " +
            "So scope it tightly — one concrete objective with a clear finish line, never a vague theme — and " +
            "front-load the context you already have (exact paths, file/symbol names, findings so far, constraints, " +
            "conventions to follow) so it never re-discovers what you already know. State exactly what to return. " +
            "It runs autonomously and cannot ask questions. " +
            "If an earlier task's report is missing a detail, don't relaunch from scratch: pass follow_up with " +
            "that task call's tool call id — the subagent continues with the earlier run's context intact, so the " +
            "prompt need only contain the new question. " +
            "INDEPENDENT tasks can and should be launched in parallel: emit several task calls in the same step " +
            "(e.g. one per area to investigate) and they run concurrently — much faster than one at a time. " +
            "Keep tasks that depend on each other's results sequential, and don't mix task with other tool " +
            "calls in the same step — the subagents cover the exploration themselves.",
        inputSchema: z.object({
            agent: z
                .string()
                .optional()
                .describe(
                    `Optional named agent to run instead of a fork of yourself (its prompt applies; its tools are capped to yours). One of: ${agentNames}`,
                ),
            prompt: z
                .string()
                .describe(
                    "Self-contained task for the subagent: one precise objective, the context you already have " +
                        "(exact paths, names, findings, constraints), and the exact output you expect back. The " +
                        "subagent sees only this prompt — assume no shared context. With follow_up, just the new " +
                        "question or instruction — the earlier run's context carries over.",
                ),
            follow_up: z
                .string()
                .optional()
                .describe(
                    "Tool call id of an earlier task call in this session to continue. The subagent resumes with " +
                        "that run's prompt and activity as context instead of starting blank; its agent is reused " +
                        "(agent is ignored). Use for narrow follow-up questions on work a subagent already did.",
                ),
        }),
        execute: (input, options) =>
            runSubagent(
                ctx,
                input.agent,
                input.prompt,
                (options as { toolCallId?: string })?.toolCallId ?? "task",
                input.follow_up,
                gate,
            ),
        // Anti-bloat (AI SDK subagents pattern): the parent model receives only
        // the subagent's final report, bounded — never the full history of
        // intermediate tool calls or file contents. The history is the tool
        // *output* (rendered in the tool box, persisted with the session);
        // toModelOutput is what keeps it out of the parent context. Without
        // this a runaway subagent could blow the main context, defeating the
        // point of delegating.
        // NOTE: the SDK calls this with an options object ({ toolCallId, input,
        // output }), not the bare output — destructure, or the parent reads the
        // wrapper and every report degrades to the no-response placeholder.
        toModelOutput: taskToolModelOutput,
    });
}

/** What the parent model receives for a task tool call. Exported for tests:
 * the argument shape must match the SDK's createToolModelOutput call site —
 * an options object, NOT the bare output (regression: reading the wrapper
 * made every subagent report degrade to the no-response placeholder). */
export function taskToolModelOutput({ output }: { output: unknown }): { type: "text"; value: string } {
    return { type: "text", value: boundReport(reportOf(output)) };
}

/** Per-run cost/effort summary — shown in the task box title and persisted so
 * replay renders the same line. usd is absent when the model isn't priceable. */
export interface SubagentStats {
    steps: number;
    durationMs: number;
    usd?: number;
    model: string;
}

export interface SubagentOutput {
    /** Full ordered run (text/reasoning/tool parts, stream order) — what the box shows. */
    history: SubagentActivityPart[];
    /** The subagent's final response text — what the parent model reads. */
    report: string;
    /** Run summary for display (never sent to the parent model). */
    stats?: SubagentStats;
}

// A follow-up run replays each prior run's transcript as one assistant
// message. Tail-capped per run so a chain of long runs can't blow the
// follow-up's own context before it starts.
const MAX_FOLLOWUP_TRANSCRIPT_CHARS = 12_000;

/**
 * Reconstruct the conversation of a prior subagent run — and any runs it
 * itself continued — as alternating user/assistant messages, so a follow_up
 * task resumes with that context instead of starting blank. Walks the
 * followUpOf chain backwards (cycle-safe); returns undefined when the id
 * doesn't match a persisted run on this branch. Pure + exported for tests.
 */
export function buildFollowUpThread(
    entries: Entry[],
    followUpId: string,
): { agent: string; messages: ModelMessage[] } | undefined {
    const byCallId = new Map<string, Extract<Entry, { type: "subagent" }>>();
    for (const e of entries) {
        if (e.type === "subagent" && e.toolCallId) byCallId.set(e.toolCallId, e);
    }
    const target = byCallId.get(followUpId);
    if (!target) return undefined;

    // Oldest-first chain: target's ancestors via followUpOf, then target.
    const chain: Extract<Entry, { type: "subagent" }>[] = [];
    const seen = new Set<string>();
    for (
        let run: typeof target | undefined = target;
        run;
        run = run.followUpOf ? byCallId.get(run.followUpOf) : undefined
    ) {
        if (run.toolCallId && seen.has(run.toolCallId)) break;
        if (run.toolCallId) seen.add(run.toolCallId);
        chain.unshift(run);
    }

    const messages: ModelMessage[] = [];
    for (const run of chain) {
        // The flattened activity (text + `> tool` lines) beats the bare report:
        // the follow-up sees what was already explored and doesn't redo it.
        let transcript = (run.activity ? formatSubagentActivity(run.activity) : "") || run.result;
        if (transcript.length > MAX_FOLLOWUP_TRANSCRIPT_CHARS) {
            transcript = `[earlier activity truncated]\n…${transcript.slice(-MAX_FOLLOWUP_TRANSCRIPT_CHARS)}`;
        }
        messages.push({ role: "user", content: run.prompt });
        messages.push({ role: "assistant", content: transcript || "(no output)" });
    }
    return { agent: target.agent, messages };
}

/**
 * Flatten an activity log to display text: text parts as-is, tool parts as
 * "> name summary" lines. Reasoning is skipped (the live view never streams
 * it); it's kept in the parts so a future renderer can style it.
 */
export function formatSubagentActivity(parts: SubagentActivityPart[]): string {
    let out = "";
    for (const p of parts) {
        if (p.type === "tool") {
            out += `${out && !out.endsWith("\n") ? "\n" : ""}> ${p.name}${p.summary}\n`;
        } else if (p.type === "text") {
            out += p.text;
        }
    }
    return out.trim();
}

/** Final text for the model — always non-empty, even when the subagent never
 * produced a closing response (aborted, tool-only run, provider hiccup). */
function reportOf(output: unknown): string {
    const o = output as (Partial<SubagentOutput> & { hook_feedback?: unknown }) | string | null;
    const report = typeof o === "string" ? o : (o?.report ?? "");
    const text = report.trim() || "(subagent finished without a final response)";
    // PostToolUse hooks attach feedback onto the output object — keep it
    // visible to the parent model, not just in the transcript.
    const feedback = typeof o === "object" && o?.hook_feedback ? `\n\n[hook] ${JSON.stringify(o.hook_feedback)}` : "";
    return text + feedback;
}

// Cap the report handed to the parent model. Generous enough for a real
// report, bounded so delegation always shrinks (never grows) main context.
const MAX_REPORT_CHARS = 24_000;
function boundReport(report: string): string {
    if (report.length <= MAX_REPORT_CHARS) return report;
    return `${report.slice(0, MAX_REPORT_CHARS)}\n\n[subagent report truncated at ${MAX_REPORT_CHARS} chars — ask a narrower follow-up task if you need more]`;
}

/**
 * Resolve which model a subagent runs on. Precedence: the target agent's own
 * `model:` (file frontmatter) > the `subagentModel` setting > the parent's
 * model. A configured model must exist in the catalog AND be available
 * (provider logged in) — otherwise fail SOFT: fall back to the parent's model
 * and return a warning, so a stale agent file or a logged-out provider never
 * bricks delegation. Pure + exported so the precedence is unit-testable.
 */
export function resolveSubagentModel(opts: {
    agentModel?: string;
    settingModel?: string;
    parentModelId: string;
    catalog: Record<string, { available?: boolean }>;
}): { modelId: string; warning?: string } {
    const configured = opts.agentModel?.trim() || opts.settingModel?.trim();
    if (!configured || configured === opts.parentModelId) return { modelId: opts.parentModelId };
    const info = opts.catalog[configured];
    if (!info) {
        return {
            modelId: opts.parentModelId,
            warning: `subagent model "${configured}" not found in the catalog — using ${opts.parentModelId}`,
        };
    }
    if (info.available === false) {
        return {
            modelId: opts.parentModelId,
            warning: `subagent model "${configured}" is not available (provider not logged in?) — using ${opts.parentModelId}`,
        };
    }
    return { modelId: configured };
}

/**
 * Resolve a subagent's effective tool names: the target agent's own tools,
 * intersected with the parent's effective tools. `task` is always stripped
 * (no nesting). A fork (target = parent agent) resolves to exactly the
 * parent's tools; a named override can only narrow, never widen.
 * Pure + exported so the security boundary is unit-testable.
 *   - allFileTools: the file-tool names available (no "task")
 *   - targetTools:  target agent's tools (undefined = all)
 *   - cap:          parent's effective tools (undefined = no cap)
 */
export function resolveSubagentTools(
    allFileTools: string[],
    targetTools: string[] | undefined,
    cap: string[] | undefined,
): string[] {
    const base = (targetTools?.length ? targetTools : allFileTools).filter((t) => allFileTools.includes(t));
    const capped = cap?.length ? base.filter((t) => cap.includes(t)) : base;
    return capped.filter((t) => t !== "task");
}

async function runSubagent(
    ctx: SubagentCtx,
    agentName: string | undefined,
    prompt: string,
    toolCallId: string,
    followUp?: string,
    gate?: Semaphore,
): Promise<SubagentOutput> {
    // No override → fork of the turn's agent (session agent or one-shot
    // /<agent> for this message): same prompt, same tools, fresh context.
    const fork = ctx.turnAgent && agentExists(ctx.turnAgent) ? ctx.turnAgent : DEFAULT_AGENT_NAME;
    let name = agentName && agentExists(agentName) ? agentName : fork;
    // follow_up → resume a prior run: its transcript becomes the message
    // history and its agent wins (continuity beats the agent param). A stale
    // id fails soft — run fresh, with a visible warning below.
    const followUpThread = followUp ? buildFollowUpThread(ctx.session.getBranch(), followUp) : undefined;
    if (followUpThread && agentExists(followUpThread.agent)) name = followUpThread.agent;
    // Stall watchdog: a provider stream that goes silent without erroring
    // (dead socket, server-side hang) would otherwise pin the run forever —
    // the parent turn can only wait. The controller chains the parent signal,
    // so Esc still aborts everything; the timer trips only while we're waiting
    // on the PROVIDER (armed between parts, disarmed while the subagent's own
    // tools run, so a long build can't false-trip it).
    const stall = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stalled = false;
    const onParentAbort = () => stall.abort();
    let slotHeld = false;
    try {
        // Parallel fan-out shares the turn's stream-slot gate: over-limit
        // tasks wait here (visibly, and abort-aware — Esc unwinds a queued
        // task without it ever opening a stream).
        if (gate) {
            if (!gate.tryAcquire()) {
                ctx.emitter.emit("subagent-delta", {
                    toolCallId,
                    agent: name,
                    text: "[queued — waiting for a free subagent slot]\n",
                });
                await gate.acquire(ctx.abortSignal);
            }
            slotHeld = true;
        }
        if (ctx.abortSignal?.aborted) {
            return { history: [], report: "Subagent aborted before it started (turn interrupted)." };
        }
        // Which model this subagent runs on: the agent file's `model:` >
        // the subagentModel setting > the parent's model. Everything below
        // (provider, catalog caps, caching, cost stamping) derives from this
        // id, so a subagent can run on a different provider than the parent.
        const catalog = await getCatalog();
        const { modelId, warning: modelWarning } = resolveSubagentModel({
            agentModel: getAgentModel(name),
            settingModel: getSetting("subagentModel"),
            parentModelId: ctx.modelId,
            catalog,
        });
        // MCP tools the parent exposed are inheritable: they're already in
        // ctx.parentTools, so the resolver's cap keeps them for a fork and drops
        // them for a named agent that doesn't list them — the same widen/narrow
        // rule files get. They already carry per-call timeouts (set when the
        // manager built them) and run the same hooks below.
        const mcpManager = getMcpManager();
        const mcpTools = getMcpManager().getTools();
        // The resource reader is a candidate on the same terms as the MCP
        // tools themselves: inherited by a fork, kept by a named agent only if
        // it lists the name. Built only when a server publishes resources.
        const mcpResourceTool =
            mcpManager.listResources().length > 0 || mcpManager.listResourceTemplates().length > 0
                ? {
                      [MCP_RESOURCE_TOOL_NAME]: createMcpResourceTool({
                          listResources: () => mcpManager.listResources(),
                          listResourceTemplates: () => mcpManager.listResourceTemplates(),
                          readResource: (server, uri) => mcpManager.readResource(server, uri),
                      }),
                  }
                : {};
        // Extension tools (and removals) are candidates too, exactly like MCP —
        // the resolver's parentTools cap then keeps them for a fork and drops
        // them for a named agent that doesn't list them. Empty when no
        // extensions are loaded, so the candidate pool is unchanged.
        const extTools = getExtensionHost().getTools();
        const fileToolNames = Object.keys(createTools({ cwd: ctx.cwd, abortSignal: ctx.abortSignal }));
        const candidateNames = [
            ...fileToolNames,
            ...Object.keys(mcpTools),
            ...Object.keys(mcpResourceTool),
            ...extTools.add.keys(),
        ].filter(
            (n) => !extTools.remove.has(n),
        );
        const effective = resolveSubagentTools(candidateNames, getAgentTools(name), ctx.parentTools);
        // A subagent allowed bash but not write/edit (e.g. a plan fork) gets the
        // same fail-closed read-only sandbox guarantee as the top-level agent.
        const readOnlyFs = isReadOnlyBashAgent(effective);
        const full: Record<string, unknown> = {
            // Same sessionId as the parent turn: subagent reads share the
            // session and must unlock parent edits (and vice versa).
            ...createTools({ cwd: ctx.cwd, abortSignal: ctx.abortSignal, readOnlyFs, sessionId: ctx.sessionId }),
            ...mcpTools,
            ...mcpResourceTool,
            ...Object.fromEntries(extTools.add),
        };
        for (const n of extTools.remove) delete full[n];
        // Cast mirrors the main turn (toolsForTurn → fullToolSet): the merged
        // map is structurally a ToolSet; MCP entries are AI-SDK tools too.
        const subTools = Object.fromEntries(
            Object.entries(full).filter(([n]) => effective.includes(n)),
        ) as unknown as ReturnType<typeof createTools>;
        // Subagent tool calls run the same PreToolUse/PostToolUse hooks,
        // tagged with agent_id so watchers can tell them apart.
        const { provider: subProvider, model: subModel } = parseModelId(modelId);
        const hooked = withToolHooks(subTools, {
            cwd: ctx.cwd,
            sessionId: ctx.sessionId,
            transcriptPath: ctx.transcriptPath,
            emitter: ctx.emitter,
            agentId: toolCallId,
            // Extension onCall/onResult middleware applies in subagents too
            // (isSubagent: true lets a transform scope itself). Empty → pass-through.
            callMiddleware: getExtensionHost().getToolCallMiddleware(),
            resultMiddleware: getExtensionHost().getToolResultMiddleware(),
            turnContext: {
                sessionId: ctx.sessionId,
                transcriptPath: ctx.transcriptPath,
                cwd: ctx.cwd,
                agent: name,
                modelId,
                provider: subProvider,
                model: subModel,
                tools: Object.keys(subTools),
                isSubagent: true,
                contextWindow: 0,
            },
        });
        const maxSteps = getSetting("subagentMaxSteps") || 50;
        // Same composition as the parent's system prompt (workspace context +
        // agent prompt + skills) so a fork behaves like the main agent — only
        // the subagent run rules and the missing task tool differ.
        const system =
            buildSystemPrompt({
                cwd: ctx.cwd,
                workspaceContext: ctx.workspaceContext,
                basePrompt: getAgentPrompt(name),
                tools: Object.keys(subTools),
            }) +
            (ctx.skillsPrompt ?? "") +
            SUBAGENT_SYSTEM_SUFFIX;
        // Shared provider shaping (see model-call.ts): Anthropic caching —
        // anchored system + per-step moving tail breakpoint, without which
        // every subagent step re-billed its whole accumulated context at full
        // input price — plus the session thinking level and output-cap pin,
        // all matching runTurn by construction.
        const call = buildAgentCallConfig({
            provider: subProvider,
            modelShortId: subModel,
            thinkingLevel: getSetting("thinkingLevel") ?? "off",
            modelInfo: catalog[modelId],
        });
        // AI SDK's native agent loop — same streamText core runTurn uses, with
        // the loop/stop handling owned by the SDK.
        const agent = new ToolLoopAgent({
            model: await getModel(modelId),
            instructions: call.anthropicCaching ? anthropicCachedSystem(system) : system,
            tools: hooked,
            stopWhen: isStepCount(maxSteps),
            ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
            ...(call.reasoning ? { reasoning: call.reasoning } : {}),
            ...(call.providerOptions ? { providerOptions: call.providerOptions as never } : {}),
            ...(call.prepareStep ? { prepareStep: call.prepareStep } : {}),
        });
        const stallSeconds = getSetting("subagentStallSeconds") ?? 180;
        if (ctx.abortSignal?.aborted) stall.abort();
        else ctx.abortSignal?.addEventListener("abort", onParentAbort);
        // Armed only while the provider owes us the next part: every stream
        // part re-arms; a pending tool execution disarms (tools have their own
        // timeouts and can legitimately run long).
        let pendingTools = 0;
        const rearmStall = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = null;
            if (stallSeconds > 0 && pendingTools === 0 && !stall.signal.aborted) {
                stallTimer = setTimeout(() => {
                    stalled = true;
                    stall.abort();
                }, stallSeconds * 1000);
            }
        };

        // Follow-up: prior runs replay as user/assistant pairs, the new prompt
        // is the final user message — same shape a live conversation would have.
        const result = followUpThread
            ? await agent.stream({
                  messages: [...followUpThread.messages, { role: "user" as const, content: prompt }],
                  abortSignal: stall.signal,
              })
            : await agent.stream({ prompt, abortSignal: stall.signal });

        const startedAt = Date.now();
        let steps = 0;
        // Billed USD summed per step, stamped with the model that ran — the
        // live `step N · $x` ticker and the persisted per-run cost. Unknown
        // model → stays undefined (never a misleading $0.00).
        let usdTotal: number | undefined;
        let totalUsage: UsageBlock | undefined;
        // Per-step accrual (running sum for abort-safe cost seeding + ledger
        // rows awaiting attribution to the single subagent entry).
        const billing = createStepBilling(ctx.tracker, modelId, {
            cwd: ctx.cwd,
            sessionPub: ctx.sessionId,
            source: "subagent",
        });
        // One ordered activity log: text, reasoning, and tool parts appended in
        // stream order so the subagent's real flow (text → tool → text → …) is
        // preserved — structured, so renderers can style each kind on its own.
        // Consecutive deltas of the same kind merge into one part.
        const activity: SubagentActivityPart[] = [];
        // Fail-soft model fallback is never silent: the warning leads the
        // activity box (live + persisted) so the user sees which model ran.
        if (modelWarning) {
            const text = `[${modelWarning}]\n`;
            activity.push({ type: "text", text });
            ctx.emitter.emit("subagent-delta", { toolCallId, agent: name, text });
        }
        // Same fail-soft visibility for a follow_up id that matched no run.
        if (followUp && !followUpThread) {
            const text = `[follow_up "${followUp}" matches no earlier task in this session — starting fresh]\n`;
            activity.push({ type: "text", text });
            ctx.emitter.emit("subagent-delta", { toolCallId, agent: name, text });
        }
        const appendDelta = (type: "text" | "reasoning", text: string) => {
            const last = activity[activity.length - 1];
            if (last && last.type === type) last.text += text;
            else activity.push({ type, text });
        };
        const maybeYield = createYieldGate();
        rearmStall();
        try {
            for await (const part of result.stream) {
                // Covers the parent's Esc too — the parent signal chains into stall.
                if (stall.signal.aborted) break;
                // Watchdog accounting: a tool call in flight means the silence is
                // ours, not the provider's; every part proves liveness and re-arms.
                if (part.type === "tool-call") pendingTools++;
                else if (part.type === "tool-result" || part.type === "tool-error")
                    pendingTools = Math.max(0, pendingTools - 1);
                rearmStall();
                switch (part.type) {
                    case "text-delta":
                        appendDelta("text", part.text);
                        ctx.emitter.emit("subagent-delta", { toolCallId, agent: name, text: part.text });
                        break;
                    case "reasoning-delta":
                        appendDelta("reasoning", part.text);
                        break;
                    case "tool-call": {
                        const toolName = (part as { toolName?: string }).toolName;
                        const input = (part as { input?: unknown }).input;
                        activity.push({ type: "tool", name: toolName ?? "tool", summary: subagentArgSummary(input) });
                        ctx.emitter.emit("subagent-tool", { toolCallId, agent: name, toolName, input });
                        break;
                    }
                    case "finish-step": {
                        // Per-step cost accrual into the parent's tracker — the
                        // footer ticks while the subagent works, and aborts keep
                        // the spend of completed steps.
                        steps++;
                        const u = (part as { usage?: UsageBlock }).usage;
                        if (u) {
                            billing.onStepUsage(u);
                            const stepUsd = stampUsageCost(modelId, u).usd;
                            if (stepUsd !== undefined) usdTotal = (usdTotal ?? 0) + stepUsd;
                            ctx.emitter.emit("subagent-step-usage", {
                                toolCallId,
                                agent: name,
                                usage: u,
                                steps,
                                usd: usdTotal,
                            });
                        }
                        break;
                    }
                    case "finish": {
                        totalUsage = (part as { totalUsage?: UsageBlock }).totalUsage;
                        ctx.emitter.emit("subagent-finish", { toolCallId, agent: name, usage: totalUsage });
                        break;
                    }
                }
                // Yield to the event loop between buffered parts so the parent
                // TUI's render timers fire — see model-call.ts for the rationale.
                await maybeYield();
            }
        } catch (streamErr) {
            // An aborted stream may end by throwing (SDK/provider dependent).
            // For our own aborts (stall trip or parent Esc) that's a normal
            // ending: fall through so the partial run still persists and the
            // parent still gets the stall report. Real errors keep throwing.
            if (!stall.signal.aborted) throw streamErr;
        }

        // SubagentStop hooks — informational for watchers, block is meaningless.
        const stop = await runHooks(
            "SubagentStop",
            undefined,
            {
                session_id: ctx.sessionId,
                transcript_path: ctx.transcriptPath,
                agent_id: toolCallId,
                stop_hook_active: false,
            },
            ctx.cwd,
        );
        for (const m of stop.messages) ctx.emitter.emit("hook-message", m);
        for (const s of stop.terminalSequences) ctx.emitter.emit("hook-terminal-sequence", s);

        // Report = the AI SDK's final response text (result.text — the
        // subagent's concluding message), not the concatenation of every
        // intermediate step's text. It can legitimately be empty (aborted
        // mid-run, tool-only finish); toModelOutput substitutes a default so
        // the parent model always receives something.
        let report = "";
        try {
            report = (await result.text).trim();
        } catch {
            // aborted/errored before a final response — report stays empty
        }

        // A tripped watchdog is never silent: the box shows why the run ended,
        // and the parent model gets a report it can act on (the run persisted,
        // so follow_up can resume from the partial work instead of restarting).
        if (stalled) {
            const note = `[aborted: provider streamed nothing for ${stallSeconds}s — stalled connection]`;
            activity.push({ type: "text", text: `\n${note}\n` });
            ctx.emitter.emit("subagent-delta", { toolCallId, agent: name, text: `\n${note}\n` });
            if (!report) {
                const tail = formatSubagentActivity(activity).slice(-3000);
                report =
                    `Subagent aborted after ${steps} completed step${steps === 1 ? "" : "s"}: the provider stream ` +
                    `stalled (no output for ${stallSeconds}s). Partial activity:\n${tail}\n\n` +
                    `Retry the task — pass follow_up with this call's id to continue from the partial work.`;
            }
        }

        // Persist for resume, same shape the events streamed: `activity` is
        // the full ordered run (what the box renders next time), `result` the
        // final report (what the model re-reads via toModelMessages).
        const runUsage = totalUsage ?? billing.sum;
        const stats: SubagentStats = {
            steps,
            durationMs: Date.now() - startedAt,
            usd: usdTotal,
            model: modelId,
        };
        const subagentEntry = {
            type: "subagent" as const,
            ts: Date.now(),
            agent: name,
            prompt,
            result: report || formatSubagentActivity(activity) || "(subagent produced no output)",
            activity: activity.length ? activity : undefined,
            usage: runUsage ? stampUsageCost(modelId, runUsage) : undefined,
            model: modelId,
            // The launch call's id — a later follow_up resumes this run by it.
            toolCallId,
            ...(followUpThread ? { followUpOf: followUp } : {}),
            steps: stats.steps,
            durationMs: stats.durationMs,
        };
        await ctx.session.append(subagentEntry);
        // A subagent run is many billed steps but one persisted entry —
        // attribute every step's ledger row to it.
        const entryId = (subagentEntry as { id?: string }).id;
        if (entryId) for (const rowId of billing.rowIds) attachLedgerEntry(rowId, entryId);

        // The history is the tool output (saved + rendered); toModelOutput
        // extracts the report for the model.
        return { history: activity, report, stats };
    } catch (err) {
        const msg = `Subagent failed: ${err instanceof Error ? err.message : String(err)}`;
        return { history: [{ type: "text", text: msg }], report: msg };
    } finally {
        if (slotHeld) gate?.release();
        if (stallTimer) clearTimeout(stallTimer);
        ctx.abortSignal?.removeEventListener("abort", onParentAbort);
    }
}
