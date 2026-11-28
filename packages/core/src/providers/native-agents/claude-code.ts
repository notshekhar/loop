import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { Options as ClaudeOptions, SDKMessage, SDKUserMessage, SpawnedProcess, EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { ensureOwnProcessSweep } from "../../tools/utils/own-processes";
import { CLAUDE_CODE_PROVIDER, ClaudeTurnReader } from "./claude-code-events";
import { permissionOptions } from "./claude-code-permissions";
import { nativeMcpServers, type NativeMcpServer } from "./mcp-servers";
import { cachedProbe, peekProbe } from "./probe-cache";
import { findExecutable, runCommand } from "./process";
import { nativeProgressSink } from "./progress";
import {
    type Effort,
    generateFromStream,
    nearestEffort,
    type PromptPlan,
    requestedEffort,
    streamNativeTurn,
    systemPromptOf,
    trackTurnProcess,
    type TurnOutcome,
    waitForPreviousTurn,
    type NativeAgentTurnContext,
} from "./shared";

/**
 * Claude Code as an ai-sdk provider. Runs the user's own `claude` binary
 * through the Claude Agent SDK, so it uses whatever that CLI is signed in with
 * (claude.ai subscription, API key, Bedrock/Vertex env) — loop stores nothing.
 * Its messages are read in claude-code-events.ts, its permission requests
 * answered in claude-code-permissions.ts.
 */
export { CLAUDE_CODE_PROVIDER };

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
            options: {
                pathToClaudeCodeExecutable: binary,
                abortController: ac,
                persistSession: false,
                // The same home as the auth check (see runCommand).
                env: { ...process.env, HOME: homedir() },
            },
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
        // loop's system prompt rides as Claude's own `systemPrompt`, not inline.
        return streamNativeTurn(CLAUDE_CODE_PROVIDER, options, {}, (ctx, plan, enqueue) =>
            this.runTurn(sdk.query, binary, options, ctx, plan, enqueue),
        );
    }

    private async runTurn(
        query: typeof import("@anthropic-ai/claude-agent-sdk").query,
        binary: string,
        options: LanguageModelV4CallOptions,
        ctx: NativeAgentTurnContext | undefined,
        plan: PromptPlan,
        enqueue: (part: LanguageModelV4StreamPart) => void,
    ): Promise<TurnOutcome> {
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (options.abortSignal?.aborted) ac.abort();

        const { input, endInput } = heldOpenInput(userMessageOf(plan));

        const queryOptions = queryOptionsFor({ binary, modelId: this.modelId, ac, options, ctx, plan });
        const reader = new ClaudeTurnReader(enqueue, {
            modelId: this.modelId,
            plan,
            ctx,
            progress: nativeProgressSink(ctx?.loopSessionId),
        });

        // One Claude process per loop session at a time — see waitForPreviousTurn.
        // The gate opens on the OS process's own exit: the SDK's message stream
        // can end while the process is still shutting down, and a prompt sent to
        // the session in that window is answered by the dying process.
        const gateKey = ctx ? `${CLAUDE_CODE_PROVIDER}:${ctx.loopSessionId}` : undefined;
        await waitForPreviousTurn(gateKey);
        const proc = trackedSpawn();
        queryOptions.spawnClaudeCodeProcess = proc.spawn;
        const messages = (query({ prompt: input, options: queryOptions }) as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
        let releaseProcess!: () => void;
        trackTurnProcess(gateKey, new Promise<void>((resolve) => (releaseProcess = resolve)));

        try {
            for (;;) {
                const next = await messages.next();
                if (next.done) break;
                if (reader.read(next.value) === "missing-session") return "missing-session";
                if (reader.finished) {
                    endInput();
                    break;
                }
            }
        } catch (err) {
            if (!ac.signal.aborted) {
                if (reader.isMissingSession(err instanceof Error ? err.message : String(err))) return "missing-session";
                throw err;
            }
        } finally {
            endInput();
            options.abortSignal?.removeEventListener("abort", onAbort);
            void drainAndRelease(messages, ac, proc, reader.finished, releaseProcess);
        }
        reader.endUnfinished();
        return "done";
    }
}

/**
 * The turn's input: the one user message, then held open until the turn ends
 * — permission callbacks and interrupts travel over the same channel.
 */
function heldOpenInput(message: SDKUserMessage): { input: AsyncGenerator<SDKUserMessage>; endInput: () => void } {
    let endInput!: () => void;
    const inputDone = new Promise<void>((resolve) => (endInput = resolve));
    async function* input(): AsyncGenerator<SDKUserMessage> {
        yield message;
        await inputDone;
    }
    return { input: input(), endInput };
}

function queryOptionsFor(turn: {
    binary: string;
    modelId: string;
    ac: AbortController;
    options: LanguageModelV4CallOptions;
    ctx: NativeAgentTurnContext | undefined;
    plan: PromptPlan;
}): ClaudeOptions {
    const system = systemPromptOf(turn.options.prompt);
    return {
        pathToClaudeCodeExecutable: turn.binary,
        abortController: turn.ac,
        model: turn.modelId,
        includePartialMessages: true,
        ...claudeReasoningOptions(modelCaps(turn.modelId), requestedEffort(turn.options)),
        ...permissionOptions(turn.ctx),
        ...(turn.ctx ? turnOptions(turn.ctx, turn.plan, system) : utilityOptions(system)),
    };
}

function userMessageOf(plan: PromptPlan): SDKUserMessage {
    const content = [
        ...(plan.text ? [{ type: "text" as const, text: plan.text }] : []),
        ...plan.images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
        })),
    ];
    return {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: plan.resumeId ?? "",
    } as unknown as SDKUserMessage;
}

/**
 * A real turn: Claude Code's own prompt and settings, with loop's prompt
 * (workspace rules Claude doesn't read itself, memory, skills) appended, and
 * loop's MCP servers alongside the ones Claude already has.
 */
function turnOptions(ctx: NativeAgentTurnContext, plan: PromptPlan, system: string): Partial<ClaudeOptions> {
    return {
        cwd: ctx.cwd,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", ...(system ? { append: system } : {}) },
        ...claudeMcpOptions(nativeMcpServers(ctx.cwd)),
        ...(plan.resumeId ? { resume: plan.resumeId } : {}),
    };
}

/**
 * Utility call (title, recap, summary): a plain completion. `tools: []` alone
 * still leaves the account's claude.ai connector tools attached; strict MCP
 * config drops them, so the single turn can't be spent on a tool call.
 */
function utilityOptions(system: string): Partial<ClaudeOptions> {
    return {
        persistSession: false,
        maxTurns: 1,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        ...(system ? { systemPrompt: system } : {}),
    };
}

/** loop's servers in the SDK's shape; denied tools become disallowed `mcp__server__tool`s. */
export function claudeMcpOptions(servers: readonly NativeMcpServer[]): Partial<ClaudeOptions> {
    if (servers.length === 0) return {};
    const mcpServers: NonNullable<ClaudeOptions["mcpServers"]> = {};
    const disallowedTools: string[] = [];
    for (const s of servers) {
        mcpServers[s.name] =
            s.kind === "stdio"
                ? { type: "stdio", command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }
                : { type: s.kind, url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
        for (const tool of s.deniedTools) disallowedTools.push(`mcp__${s.name}__${tool}`);
    }
    return { mcpServers, ...(disallowedTools.length ? { disallowedTools } : {}) };
}

/**
 * Spawn the CLI ourselves so the turn can wait on the OS process's exit, and
 * so loop's exit sweep knows to take down whatever it starts (its Bash
 * children must not outlive loop).
 */
function trackedSpawn(): { spawn: NonNullable<ClaudeOptions["spawnClaudeCodeProcess"]>; exited: () => Promise<void>; kill: () => void } {
    let child: ChildProcess | undefined;
    let exited: Promise<void> = Promise.resolve();
    return {
        spawn: (spawnOptions) => {
            ensureOwnProcessSweep();
            child = spawn(spawnOptions.command, spawnOptions.args, {
                cwd: spawnOptions.cwd,
                env: spawnOptions.env as NodeJS.ProcessEnv,
                stdio: ["pipe", "pipe", "pipe"],
                signal: spawnOptions.signal,
            });
            child.stderr?.resume();
            const spawned = child;
            exited = new Promise<void>((resolve) => {
                spawned.once("exit", () => resolve());
                spawned.once("error", () => resolve());
            });
            return spawned as unknown as SpawnedProcess;
        },
        exited: () => exited,
        kill: () => child?.kill("SIGKILL"),
    };
}

/**
 * With its input closed the CLI exits on its own — unless background work
 * keeps it alive, so it gets a short grace period, then is killed. The
 * session gate stays closed until the process is really gone.
 */
async function drainAndRelease(
    messages: AsyncIterator<SDKMessage>,
    ac: AbortController,
    proc: ReturnType<typeof trackedSpawn>,
    finished: boolean,
    release: () => void,
): Promise<void> {
    const kill = setTimeout(() => ac.abort(), finished ? EXIT_GRACE_MS : 0);
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
        const hardKill = setTimeout(proc.kill, EXIT_GRACE_MS);
        await proc.exited();
        clearTimeout(hardKill);
        release();
    }
}

export function createClaudeCodeModel(modelId: string): LanguageModelV4 {
    return new ClaudeCodeLanguageModel(modelId);
}
