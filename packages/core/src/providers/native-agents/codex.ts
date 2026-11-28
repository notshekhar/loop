import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { answerCodexRequest } from "./codex-approvals";
import { CodexTurnReader } from "./codex-events";
import { CodexRpc } from "./codex-rpc";
import { writeTurnImages } from "./images";
import { nativeMcpServers, type NativeMcpServer } from "./mcp-servers";
import { cachedProbe, peekProbe } from "./probe-cache";
import { findExecutable, runCommand } from "./process";
import {
    type Effort,
    generateFromStream,
    linkNativeSession,
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
 * OpenAI's Codex as an ai-sdk provider, driving the user's `codex` CLI over
 * its app-server protocol (see codex-rpc.ts). The CLI's own login (ChatGPT or
 * an API key) authenticates; loop stores nothing.
 */
// Not plain "codex": the desktop/web app inherits t3code's own `codex` driver
// kind, and sharing its id hides the models the same way it did for Cursor.
export const CODEX_PROVIDER = "codex-cli" as const;

export function findCodexBinary(): string | undefined {
    return findExecutable(["codex"], "CODEX_BIN");
}

// ---- detection ---------------------------------------------------------------

export interface CodexModel {
    slug: string;
    name: string;
    contextWindow?: number;
    efforts: Effort[];
    defaultEffort?: Effort;
    images: boolean;
}

export interface CodexProbe {
    binary: string;
    loggedIn: boolean;
    /** How the CLI is signed in ("ChatGPT", "an API key"), as it reports it. */
    account?: string;
    models: CodexModel[];
}

const PROBE_KEY = CODEX_PROVIDER;
const EFFORTS = new Set<string>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** `codex debug models` → the models the picker should offer. */
export function parseCodexModels(json: string): CodexModel[] {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return [];
    }
    const list = (Array.isArray(raw) ? raw : ((raw as { models?: unknown })?.models ?? [])) as Array<Record<string, unknown>>;
    if (!Array.isArray(list)) return [];
    const out: CodexModel[] = [];
    for (const m of list) {
        const slug = typeof m.slug === "string" ? m.slug : undefined;
        // Hidden ones are internal (auto-review, reserve capacity), not choices.
        if (!slug || (m.visibility !== undefined && m.visibility !== "list")) continue;
        const levels = Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as Array<{ effort?: unknown }>) : [];
        const efforts = levels.map((l) => String(l.effort)).filter((e): e is Effort => EFFORTS.has(e));
        const def = typeof m.default_reasoning_level === "string" && EFFORTS.has(m.default_reasoning_level) ? (m.default_reasoning_level as Effort) : undefined;
        out.push({
            slug,
            name: typeof m.display_name === "string" && m.display_name ? m.display_name : slug,
            ...(typeof m.context_window === "number" && m.context_window > 0 ? { contextWindow: m.context_window } : {}),
            efforts,
            ...(def ? { defaultEffort: def } : {}),
            images: Array.isArray(m.input_modalities) && (m.input_modalities as unknown[]).includes("image"),
        });
    }
    return out;
}

export async function probeCodex(opts: { refresh?: boolean } = {}): Promise<CodexProbe | null> {
    const binary = findCodexBinary();
    if (!binary) return null;
    return cachedProbe<CodexProbe | null>(PROBE_KEY, async () => {
        const status = await runCommand(binary, ["login", "status"], { timeoutMs: 15_000 });
        const statusText = `${status.stdout}\n${status.stderr}`;
        const login = /logged in using\s+(.+)/i.exec(statusText);
        const loggedIn = status.code === 0 && Boolean(login);
        if (!loggedIn) return { binary, loggedIn: false, models: [] };
        const list = await runCommand(binary, ["debug", "models"], { timeoutMs: 30_000 });
        return { binary, loggedIn: true, account: login?.[1]?.trim(), models: parseCodexModels(list.stdout) };
    }, opts);
}

function modelFor(slug: string): CodexModel | undefined {
    return peekProbe<CodexProbe | null>(PROBE_KEY)?.models.find((m) => m.slug === slug);
}

/** The `model_reasoning_effort` to ask for, or undefined to leave Codex's default. */
export function codexEffort(model: CodexModel | undefined, requested: Effort | undefined): Effort | undefined {
    if (requested === undefined) return undefined;
    if (!model || model.efforts.length === 0) return requested === "none" ? undefined : requested;
    return nearestEffort(requested, model.efforts);
}

// ---- thread settings -------------------------------------------------------

/** How a thread may act: the sandbox, and whether Codex asks before stepping out of it. */
export interface CodexPolicy {
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "never" | "untrusted";
}

/**
 * Loop's modes in Codex's terms. Kept pure for tests.
 * - utility call (title, recap): read-only, nothing to ask about;
 * - plan mode: read-only;
 * - approvals on: the workspace sandbox, and Codex asks — loop answers each
 *   request with its own bash gate (see codex-approvals.ts);
 * - otherwise: full access, never asks.
 */
export function codexPolicy(ctx: NativeAgentTurnContext | undefined): CodexPolicy {
    if (!ctx || ctx.planMode) return { sandbox: "read-only", approvalPolicy: "never" };
    if (ctx.approvals) return { sandbox: "workspace-write", approvalPolicy: "untrusted" };
    return { sandbox: "danger-full-access", approvalPolicy: "never" };
}

/** loop's MCP servers as Codex `mcp_servers` config entries. */
export function codexMcpConfig(servers: readonly NativeMcpServer[]): Record<string, unknown> | undefined {
    if (servers.length === 0) return undefined;
    const entries = servers.map((s) => {
        const base =
            s.kind === "stdio"
                ? { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }
                : { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) };
        return [s.name, { ...base, ...(s.deniedTools.length ? { disabled_tools: s.deniedTools } : {}) }] as const;
    });
    return { mcp_servers: Object.fromEntries(entries) };
}

/** `thread/start` / `thread/resume` parameters for one turn. */
export function codexThreadParams(input: {
    model: string;
    ctx: NativeAgentTurnContext | undefined;
    instructions: string;
    mcp: readonly NativeMcpServer[];
}): Record<string, unknown> {
    const config = input.ctx ? codexMcpConfig(input.mcp) : undefined;
    return {
        model: input.model,
        ...(input.ctx ? { cwd: input.ctx.cwd } : {}),
        ...codexPolicy(input.ctx),
        ...(input.instructions ? { developerInstructions: input.instructions } : {}),
        ...(config ? { config } : {}),
        // A utility call keeps no thread on disk.
        ...(input.ctx ? {} : { ephemeral: true }),
    };
}

// ---- the model ---------------------------------------------------------------

const CLIENT_INFO = { name: "loop", title: "loop", version: "1" };
/** After an interrupt, how long Codex gets to close the turn before loop stops waiting. */
const INTERRUPT_GRACE_MS = 3_000;

export class CodexLanguageModel implements LanguageModelV4 {
    readonly specificationVersion = "v4" as const;
    readonly provider = CODEX_PROVIDER;
    readonly supportedUrls = {};

    constructor(readonly modelId: string) {}

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
        return generateFromStream(await this.doStream(options));
    }

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
        const binary = findCodexBinary();
        if (!binary) throw new Error("Codex is not installed (no `codex` on PATH). Install it, then run `codex login`.");
        // loop's system prompt rides as the thread's developer instructions.
        return streamNativeTurn(CODEX_PROVIDER, options, {}, (ctx, plan, enqueue) => this.runTurn(binary, options, ctx, plan, enqueue));
    }

    private async runTurn(
        binary: string,
        options: LanguageModelV4CallOptions,
        ctx: NativeAgentTurnContext | undefined,
        plan: PromptPlan,
        enqueue: (part: LanguageModelV4StreamPart) => void,
    ): Promise<TurnOutcome> {
        const gateKey = ctx ? `${CODEX_PROVIDER}:${ctx.loopSessionId}` : undefined;
        await waitForPreviousTurn(gateKey);
        const reader = new CodexTurnReader(enqueue, CODEX_PROVIDER, this.modelId);
        const rpc = new CodexRpc(binary, [], { cwd: ctx?.cwd }, {
            onNotification: (method, params) => reader.onNotification(method, params),
            onRequest: (method, params) => answerCodexRequest(method, params, ctx, options.abortSignal),
        });
        trackTurnProcess(gateKey, rpc.exited);
        const images = writeTurnImages(plan.images);
        try {
            await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
            rpc.notify("initialized");
            const threadId = await this.openThread(rpc, plan, ctx, options);
            if (!threadId) return "missing-session";
            reader.threadId = threadId;
            linkNativeSession(CODEX_PROVIDER, ctx, threadId, plan.seen);
            enqueue({ type: "response-metadata", id: threadId, modelId: this.modelId });
            const turn = await rpc.request<{ turn: { id: string } }>("turn/start", {
                threadId,
                input: codexInput(plan.text, images.paths),
                model: this.modelId,
                ...effortParam(this.modelId, options),
            });
            await settleTurn(rpc, reader, { threadId, turnId: turn.turn.id }, options.abortSignal);
        } catch (err) {
            reader.endUnfinished(err instanceof Error ? err.message : String(err), options.abortSignal?.aborted === true);
        } finally {
            images.dispose();
            // The session gate (trackTurnProcess) waits on the exit; the turn doesn't have to.
            void rpc.close();
        }
        return "done";
    }

    /** Start a thread, or resume the linked one; undefined when the linked one is gone. */
    private async openThread(
        rpc: CodexRpc,
        plan: PromptPlan,
        ctx: NativeAgentTurnContext | undefined,
        options: LanguageModelV4CallOptions,
    ): Promise<string | undefined> {
        const params = codexThreadParams({
            model: this.modelId,
            ctx,
            instructions: systemPromptOf(options.prompt),
            mcp: ctx ? nativeMcpServers(ctx.cwd) : [],
        });
        if (!plan.resumeId) {
            const started = await rpc.request<{ thread: { id: string } }>("thread/start", params);
            return started.thread.id;
        }
        try {
            const resumed = await rpc.request<{ thread: { id: string } }>("thread/resume", {
                ...params,
                threadId: plan.resumeId,
                excludeTurns: true,
            });
            return resumed.thread.id;
        } catch {
            // Deleted, expired or unreadable: the caller re-seeds a fresh thread.
            return undefined;
        }
    }
}

/** The user's message: text, plus images as local files Codex reads itself. */
function codexInput(text: string, imagePaths: readonly string[]): unknown[] {
    return [
        ...(text ? [{ type: "text", text, text_elements: [] }] : []),
        ...imagePaths.map((path) => ({ type: "localImage", path })),
    ];
}

function effortParam(modelId: string, options: LanguageModelV4CallOptions): { effort?: Effort } {
    const effort = codexEffort(modelFor(modelId), requestedEffort(options));
    return effort ? { effort } : {};
}

/**
 * Wait for the turn to end. Esc asks Codex to interrupt (so its thread is
 * left in a clean state) instead of killing the process mid-write; if it
 * doesn't close the turn promptly, loop stops waiting anyway. A server that
 * dies first ends the turn with whatever it printed.
 */
async function settleTurn(
    rpc: CodexRpc,
    reader: CodexTurnReader,
    ids: { threadId: string; turnId: string },
    signal: AbortSignal | undefined,
): Promise<void> {
    let grace: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<void>((resolve) => {
        const onAbort = () => {
            void rpc.request("turn/interrupt", ids).catch(() => {});
            grace = setTimeout(resolve, INTERRUPT_GRACE_MS);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        void reader.settled.then(() => signal?.removeEventListener("abort", onAbort));
    });
    await Promise.race([reader.settled, abandoned, rpc.exited]);
    clearTimeout(grace);
    reader.endUnfinished("codex app-server exited before the turn finished", signal?.aborted === true);
}

export function createCodexModel(modelId: string): LanguageModelV4 {
    return new CodexLanguageModel(modelId);
}
