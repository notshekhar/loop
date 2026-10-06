import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type {
    CanUseTool,
    EffortLevel,
    Options as ClaudeOptions,
    PermissionResult,
    SDKMessage,
    SDKUserMessage,
    SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { getBashApprovalBridge } from "../../tools/approval-bridge";
import { cachedProbe, peekProbe } from "./probe-cache";
import { findExecutable, runCommand } from "./process";
import { mapClaudeTool } from "./tool-map";
import {
    type Effort,
    finishReason,
    generateFromStream,
    getSessionLink,
    makeUsage,
    nearestEffort,
    PartWriter,
    planPrompt,
    type PromptPlan,
    readTurnContext,
    requestedEffort,
    setSessionLink,
    streamFrom,
    stringify,
    trackTurnProcess,
    waitForPreviousTurn,
    type NativeAgentTurnContext,
} from "./shared";

/**
 * Claude Code as an ai-sdk provider. Runs the user's own `claude` binary
 * through the Claude Agent SDK, so it uses whatever that CLI is signed in with
 * (claude.ai subscription, API key, Bedrock/Vertex env) — loop stores nothing.
 */
export const CLAUDE_CODE_PROVIDER = "claude-code" as const;

export function findClaudeBinary(): string | undefined {
    return findExecutable(["claude"], "CLAUDE_CODE_BIN");
}

/** What the CLI reports for one model (Agent SDK `ModelInfo`). */
export interface ClaudeCodeModel {
    value: string;
    resolvedModel?: string;
    displayName: string;
    description: string;
    supportsEffort?: boolean;
    supportedEffortLevels?: EffortLevel[];
    supportsAdaptiveThinking?: boolean;
    supportsFastMode?: boolean;
}

export interface ClaudeCodeProbe {
    binary: string;
    loggedIn: boolean;
    email?: string;
    authMethod?: string;
    subscriptionType?: string;
    models: ClaudeCodeModel[];
}

const PROBE_KEY = "claude-code";
/** How long a finished turn's process may linger (background work) before it is killed. */
const EXIT_GRACE_MS = 3_000;
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Is Claude Code installed and signed in, and which models does the account
 * offer? `claude auth status` answers the first cheaply; the model list (with
 * per-model effort levels and thinking support) comes from the SDK's
 * initialization handshake — no prompt is ever sent, so it costs nothing.
 */
export async function probeClaudeCode(opts: { refresh?: boolean } = {}): Promise<ClaudeCodeProbe | null> {
    const binary = findClaudeBinary();
    if (!binary) return null;
    return cachedProbe<ClaudeCodeProbe | null>(PROBE_KEY, async () => {
        const status = await runCommand(binary, ["auth", "status", "--json"], { timeoutMs: 10_000 });
        let auth: { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string } = {};
        try {
            auth = JSON.parse(status.stdout) as typeof auth;
        } catch {
            /* older CLI without --json: treat as unknown → not logged in */
        }
        if (!auth.loggedIn) return { binary, loggedIn: false, models: [] };
        const models = await listModelsViaSdk(binary).catch(() => [] as ClaudeCodeModel[]);
        return {
            binary,
            loggedIn: true,
            email: auth.email,
            authMethod: auth.authMethod,
            subscriptionType: auth.subscriptionType,
            models: models.length ? models : FALLBACK_MODELS,
        };
    }, opts);
}

/** Aliases every current Claude Code accepts, for when the handshake fails. */
const FALLBACK_MODELS: ClaudeCodeModel[] = [
    { value: "opus", displayName: "Opus", description: "", supportsEffort: true, supportsAdaptiveThinking: true },
    { value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: true, supportsAdaptiveThinking: true },
    { value: "haiku", displayName: "Haiku", description: "" },
];

async function listModelsViaSdk(binary: string): Promise<ClaudeCodeModel[]> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    try {
        const q = query({
            // Never yields: only the initialization handshake is wanted.
            prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
                await new Promise<void>((resolve) => ac.signal.addEventListener("abort", () => resolve()));
            })(),
            options: { pathToClaudeCodeExecutable: binary, abortController: ac, persistSession: false },
        });
        const init = (await q.initializationResult()) as { models?: ClaudeCodeModel[] };
        return (init.models ?? []).filter((m) => m.value !== "default");
    } finally {
        clearTimeout(timer);
        ac.abort();
    }
}

function modelCaps(modelId: string): ClaudeCodeModel | undefined {
    return peekProbe<ClaudeCodeProbe | null>(PROBE_KEY)?.models.find((m) => m.value === modelId);
}

// ---- effort / thinking -------------------------------------------------------

/** Thinking budgets for models that predate adaptive thinking (loop's level descriptions). */
const THINKING_BUDGET: Record<Exclude<Effort, "none">, number> = {
    minimal: 1_024,
    low: 2_048,
    medium: 8_192,
    high: 16_384,
    xhigh: 32_000,
    max: 32_000,
};

/**
 * Translate loop's thinking level into Claude Code's knobs for THIS model:
 * adaptive models take `effort` (clamped to the levels the model lists) with
 * adaptive thinking; older models get a token budget; models without effort
 * support get no effort flag at all. "off" disables thinking outright.
 */
export function claudeReasoningOptions(
    model: ClaudeCodeModel | undefined,
    effort: Effort | undefined,
): Pick<ClaudeOptions, "thinking" | "effort"> {
    if (effort === undefined) return {};
    if (effort === "none") return { thinking: { type: "disabled" } };
    const adaptive = model?.supportsAdaptiveThinking ?? true;
    if (!adaptive) {
        return { thinking: { type: "enabled", budgetTokens: THINKING_BUDGET[effort], display: "summarized" } };
    }
    const levels = model?.supportedEffortLevels ?? (model?.supportsEffort === false ? [] : undefined);
    // "minimal" has no Claude equivalent; low is the floor.
    const target: Effort = effort === "minimal" ? "low" : effort;
    const chosen = levels === undefined ? (target as EffortLevel) : nearestEffort(target, levels);
    return { thinking: { type: "adaptive", display: "summarized" }, ...(chosen ? { effort: chosen } : {}) };
}

// ---- permissions -------------------------------------------------------------

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * Route Claude's permission requests through loop's own approval prompt, so
 * a Claude Code session asks the same way a native loop session does.
 */
function approvalCallback(ctx: NativeAgentTurnContext): CanUseTool {
    return async (toolName, input, { signal, toolUseID }): Promise<PermissionResult> => {
        if (toolName === "ExitPlanMode" && ctx.planMode) {
            return {
                behavior: "deny",
                message: "Plan mode is on in loop. Present the final plan and stop; the user will switch modes.",
                toolUseID,
            };
        }
        const bridge = getBashApprovalBridge();
        if (!bridge) return { behavior: "allow", updatedInput: input, toolUseID };
        const isBash = toolName === "Bash";
        const isEdit = EDIT_TOOLS.has(toolName);
        const decision = await bridge.confirm(
            {
                kind: isBash ? "bash" : isEdit ? "path" : "bash",
                command: isBash
                    ? String(input.command ?? "")
                    : isEdit
                      ? String(input.file_path ?? input.notebook_path ?? "")
                      : `${toolName} ${stringify(input).slice(0, 400)}`,
                cwd: ctx.cwd,
                patterns: [],
                title: `Claude Code wants to use ${toolName}`,
            },
            { signal },
        );
        return decision === "once" || decision === "always"
            ? { behavior: "allow", updatedInput: input, toolUseID }
            : { behavior: "deny", message: "The user declined this tool call.", toolUseID };
    };
}

function permissionOptions(ctx: NativeAgentTurnContext | undefined): Partial<ClaudeOptions> {
    if (!ctx) return { permissionMode: "default", tools: [] };
    if (ctx.planMode) return { permissionMode: "plan", canUseTool: approvalCallback(ctx) };
    if (ctx.approvals && getBashApprovalBridge()) return { permissionMode: "default", canUseTool: approvalCallback(ctx) };
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
}

// ---- the model ---------------------------------------------------------------

export class ClaudeCodeLanguageModel implements LanguageModelV4 {
    readonly specificationVersion = "v4" as const;
    readonly provider = CLAUDE_CODE_PROVIDER;
    readonly supportedUrls = {};

    constructor(readonly modelId: string) {}

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
        return generateFromStream(await this.doStream(options));
    }

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
        const binary = findClaudeBinary();
        if (!binary) throw new Error("Claude Code is not installed (no `claude` on PATH). Install it, then run `claude auth login`.");
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        const ctx = readTurnContext(options, CLAUDE_CODE_PROVIDER);
        const link = ctx ? getSessionLink(CLAUDE_CODE_PROVIDER, ctx.loopSessionId) : undefined;
        const plan = planPrompt(options.prompt, link, this.modelId);

        return streamFrom(async (enqueue) => {
            const outcome = await this.runTurn(sdk.query, binary, options, ctx, plan, enqueue);
            // The native session was deleted or expired: start over, seeded with loop's transcript.
            if (outcome === "missing-session") {
                const fresh = planPrompt(options.prompt, undefined, this.modelId);
                await this.runTurn(sdk.query, binary, options, ctx, fresh, enqueue);
            }
        });
    }

    private async runTurn(
        query: typeof import("@anthropic-ai/claude-agent-sdk").query,
        binary: string,
        options: LanguageModelV4CallOptions,
        ctx: NativeAgentTurnContext | undefined,
        plan: PromptPlan,
        enqueue: (part: LanguageModelV4StreamPart) => void,
    ): Promise<"done" | "missing-session"> {
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (options.abortSignal?.aborted) ac.abort();

        // Keep the input stream open until the turn ends: permission callbacks
        // and interrupts travel over the same channel.
        let endInput!: () => void;
        const inputDone = new Promise<void>((resolve) => (endInput = resolve));
        const content = [
            ...(plan.text ? [{ type: "text" as const, text: plan.text }] : []),
            ...plan.images.map((img) => ({
                type: "image" as const,
                source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
            })),
        ];
        const userMessage = {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
            session_id: plan.resumeId ?? "",
        } as unknown as SDKUserMessage;
        async function* input(): AsyncGenerator<SDKUserMessage> {
            yield userMessage;
            await inputDone;
        }

        const system = options.prompt
            .filter((m) => m.role === "system")
            .map((m) => m.content as string)
            .join("\n\n");
        const queryOptions: ClaudeOptions = {
            pathToClaudeCodeExecutable: binary,
            abortController: ac,
            model: this.modelId,
            includePartialMessages: true,
            ...claudeReasoningOptions(modelCaps(this.modelId), requestedEffort(options)),
            ...permissionOptions(ctx),
            ...(ctx
                ? {
                      cwd: ctx.cwd,
                      settingSources: ["user", "project", "local"],
                      systemPrompt: { type: "preset", preset: "claude_code" },
                      ...(plan.resumeId ? { resume: plan.resumeId } : {}),
                  }
                : {
                      // Utility call (title, recap, summary): a plain completion.
                      // `tools: []` alone still leaves the account's claude.ai
                      // connector tools attached; strict MCP config drops them,
                      // so the single turn can't be spent on a tool call.
                      persistSession: false,
                      maxTurns: 1,
                      settingSources: [],
                      strictMcpConfig: true,
                      mcpServers: {},
                      ...(system ? { systemPrompt: system } : {}),
                  }),
        };

        const w = new PartWriter(enqueue, CLAUDE_CODE_PROVIDER);
        const toolNames = new Map<string, string>();
        const streamedMessages = new Set<string>();
        const blocks = new Map<number, { kind: "text" | "thinking" | "tool"; toolId?: string }>();
        let currentMessage = "";
        let lastCallUsage: Record<string, number> | undefined;
        let sessionId = plan.resumeId;
        let producedOutput = false;
        let finished = false;

        // One Claude process per loop session at a time — see waitForPreviousTurn.
        // The gate opens on the OS process's own exit: the SDK's message stream
        // can end while the process is still shutting down, and a prompt sent to
        // the session in that window is answered by the dying process.
        const gateKey = ctx ? `${CLAUDE_CODE_PROVIDER}:${ctx.loopSessionId}` : undefined;
        await waitForPreviousTurn(gateKey);
        let child: ChildProcess | undefined;
        let processExited: Promise<void> = Promise.resolve();
        queryOptions.spawnClaudeCodeProcess = (spawnOptions) => {
            child = spawn(spawnOptions.command, spawnOptions.args, {
                cwd: spawnOptions.cwd,
                env: spawnOptions.env as NodeJS.ProcessEnv,
                stdio: ["pipe", "pipe", "pipe"],
                signal: spawnOptions.signal,
            });
            child.stderr?.resume();
            const spawned = child;
            processExited = new Promise<void>((resolve) => {
                spawned.once("exit", () => resolve());
                spawned.once("error", () => resolve());
            });
            return spawned as unknown as SpawnedProcess;
        };
        const messages = (query({ prompt: input(), options: queryOptions }) as AsyncIterable<SDKMessage>)[
            Symbol.asyncIterator
        ]();
        let releaseProcess!: () => void;
        trackTurnProcess(gateKey, new Promise<void>((resolve) => (releaseProcess = resolve)));

        try {
            for (;;) {
                const next = await messages.next();
                if (next.done) break;
                const m = next.value as SDKMessage & { parent_tool_use_id?: string | null };
                // Subagent internals: the parent's Task call and its result already tell the story.
                if (m.parent_tool_use_id) continue;
                switch (m.type) {
                    case "system": {
                        if (m.subtype === "init") {
                            sessionId = m.session_id;
                            if (ctx) {
                                setSessionLink(CLAUDE_CODE_PROVIDER, ctx.loopSessionId, {
                                    nativeId: m.session_id,
                                    seen: plan.seen,
                                    model: this.modelId,
                                    updatedAt: Date.now(),
                                });
                            }
                            enqueue({ type: "response-metadata", id: m.session_id, modelId: m.model });
                        }
                        break;
                    }
                    case "stream_event": {
                        const ev = m.event;
                        if (ev.type === "message_start") {
                            currentMessage = ev.message.id;
                            streamedMessages.add(currentMessage);
                            blocks.clear();
                        } else if (ev.type === "content_block_start") {
                            const b = ev.content_block;
                            if (b.type === "text") blocks.set(ev.index, { kind: "text" });
                            else if (b.type === "thinking") blocks.set(ev.index, { kind: "thinking" });
                            else if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") {
                                const name = mapClaudeTool(b.name, {}).name;
                                toolNames.set(b.id, name);
                                blocks.set(ev.index, { kind: "tool", toolId: b.id });
                                // Only the start is surfaced early: the streamed
                                // input is in Claude's schema, the final tool-call
                                // carries it reshaped to loop's.
                                w.toolInputStart(b.id, name);
                            }
                        } else if (ev.type === "content_block_delta") {
                            const d = ev.delta;
                            producedOutput = true;
                            if (d.type === "text_delta") w.text(d.text);
                            else if (d.type === "thinking_delta") w.reasoning(d.thinking);
                        } else if (ev.type === "content_block_stop") {
                            const b = blocks.get(ev.index);
                            if (b?.kind === "text") w.endText();
                            else if (b?.kind === "thinking") w.endReasoning();
                            else if (b?.kind === "tool" && b.toolId) enqueue({ type: "tool-input-end", id: b.toolId });
                        }
                        break;
                    }
                    case "assistant": {
                        const message = m.message;
                        if (message.usage) lastCallUsage = message.usage as unknown as Record<string, number>;
                        if (m.error) throw new Error(`Claude Code: ${m.error}`);
                        const streamed = streamedMessages.has(message.id);
                        for (const block of message.content) {
                            if (block.type === "text" && !streamed) w.text(block.text);
                            else if (block.type === "thinking" && !streamed) w.reasoning(block.thinking);
                            else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
                                const mapped = mapClaudeTool(block.name, block.input);
                                toolNames.set(block.id, mapped.name);
                                w.toolCall(block.id, mapped.name, mapped.input);
                            }
                        }
                        if (!streamed) w.endAll();
                        producedOutput = true;
                        break;
                    }
                    case "user": {
                        const c = m.message.content;
                        if (!Array.isArray(c)) break;
                        for (const block of c) {
                            if (typeof block !== "object" || block.type !== "tool_result") continue;
                            w.toolResult(
                                block.tool_use_id,
                                toolNames.get(block.tool_use_id) ?? "tool",
                                toolResultText(block.content),
                                block.is_error === true,
                            );
                        }
                        break;
                    }
                    case "result": {
                        w.endAll();
                        if (m.subtype !== "success" || m.is_error) {
                            const detail =
                                "errors" in m && m.errors.length ? m.errors.join("\n") : "result" in m ? String(m.result) : m.subtype;
                            if (!producedOutput && plan.resumeId && /no conversation found|session.*not found/i.test(detail)) {
                                return "missing-session";
                            }
                            enqueue({ type: "error", error: new Error(`Claude Code: ${detail}`) });
                        }
                        const u = lastCallUsage ?? {};
                        enqueue({
                            type: "finish",
                            usage: makeUsage({
                                // Context occupancy = the last API call's input, not the turn's sum.
                                input: u.input_tokens,
                                cacheRead: u.cache_read_input_tokens,
                                cacheWrite: u.cache_creation_input_tokens,
                                output: m.usage.output_tokens,
                            }),
                            finishReason: finishReason(m.is_error ? "error" : "stop", m.stop_reason ?? m.subtype),
                            providerMetadata: {
                                [CLAUDE_CODE_PROVIDER]: {
                                    sessionId: sessionId ?? null,
                                    costUsd: m.total_cost_usd,
                                    numTurns: m.num_turns,
                                },
                            },
                        });
                        finished = true;
                        endInput();
                        break;
                    }
                    default:
                        break;
                }
                if (finished) break;
            }
        } catch (err) {
            if (ac.signal.aborted) {
                w.endAll();
            } else {
                const text = err instanceof Error ? err.message : String(err);
                if (!producedOutput && plan.resumeId && /no conversation found|session.*not found/i.test(text)) {
                    return "missing-session";
                }
                throw err;
            }
        } finally {
            endInput();
            options.abortSignal?.removeEventListener("abort", onAbort);
            // With its input closed the CLI exits on its own — unless background
            // work keeps it alive, so it gets a short grace period, then is killed.
            // The session gate stays closed until the process is really gone.
            const kill = setTimeout(() => ac.abort(), finished ? EXIT_GRACE_MS : 0);
            void (async () => {
                try {
                    while (!(await messages.next()).done) {
                        /* output after the result belongs to no turn */
                    }
                } catch {
                    /* aborted */
                } finally {
                    clearTimeout(kill);
                    ac.abort();
                    // The SDK escalates to a kill on its own; this is the backstop.
                    const hardKill = setTimeout(() => child?.kill("SIGKILL"), EXIT_GRACE_MS);
                    await processExited;
                    clearTimeout(hardKill);
                    releaseProcess();
                }
            })();
        }
        if (!finished) {
            w.endAll();
            enqueue({ type: "finish", usage: makeUsage({}), finishReason: finishReason("other", "aborted") });
        }
        return "done";
    }
}

function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : `[${(c as { type?: string }).type ?? "content"}]`))
            .join("\n");
    }
    return stringify(content);
}

export function createClaudeCodeModel(modelId: string): LanguageModelV4 {
    return new ClaudeCodeLanguageModel(modelId);
}
