import { getConfigDir, PRODUCT_NAME } from "../brand";
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    buildSessionTreeView,
    extractMessageText,
    SessionManager,
    stripSessionHookContext,
    type Session,
    type SessionScope,
} from "../sessions";
import {
    runTurn,
    CostTracker,
    runCompact,
    TURN_EVENT_NAMES,
    buildContextReport,
    generateCommitMessage,
} from "../agent";
import {
    agentExists,
    agentToolNames,
    deleteAgent,
    getAgentModel,
    getAgentPrompt,
    getAgentTools,
    hasBuiltinOverride,
    isBuiltinAgent,
    isValidAgentName,
    listAgents,
    saveAgent,
} from "../agent/agents";
import { setAskUserBridge, type AskAnswer, type AskQuestion } from "../tools/ask-bridge";
import { killAllBashChildren, killSessionShells } from "../tools/utils/shell-registry";
import { THINKING_LEVELS, type ThinkingLevel } from "../agent/thinking";
import {
    artifactFilePath,
    deleteArtifact,
    exportArtifact,
    getArtifact,
    listArtifacts,
    readArtifact,
    type ArtifactMeta,
} from "../artifacts";
import { bustCatalogCache, getCatalog, listUsableProviders } from "../catalog";
import { CommandRegistry, registerBuiltins } from "../commands";
import { getExtensionHost, setBuiltinEnabled, setRecordEnabled } from "../extensions";
import {
    deleteCustomProvider,
    getActiveProvider,
    isCustomProvider,
    listAuthorizedProviders,
    loginApiKey,
    logout,
    parseCustomProviderId,
    refreshConfigStores,
} from "../auth";
import {
    answerAuthFlow,
    cancelAuthFlow,
    listProviderDescriptors,
    pollAuthFlow,
    startAuthFlow,
    type AuthMethod,
} from "./auth-flows";
import {
    discoverCustomProviderModels,
    listCustomProviderSummaries,
    removeCustomProvider,
    saveCustomProviderConfig,
    setActiveCustomProvider,
} from "./custom-providers";
import { cancelMcpLogin, listMcpServers, parseServerConfig, pollMcpLogin, startMcpLogin } from "./mcp-flows";
import { parseDatasourceConfig } from "./datasource-flows";
import {
    type DataSourceConfig,
    deleteDatasource,
    getDatasource,
    isValidConnectionId,
    listDatasources,
    saveDatasource,
} from "../datasources/config";
import { closeAllPools, closePool, testConnection } from "../datasources/client";
import {
    addProjectServer,
    getMcpManager,
    getProjectServers,
    removeProjectServer,
    setProjectServerEnabled,
} from "../mcp";
import { getSetting, setSetting, type AppSettings } from "../settings";
import { buildSteakGrid } from "../agent/steak";
import { parseModelId } from "../providers";
import { RpcErrorCode, type RpcNotification, type RpcRequest, type RpcResponse } from "./protocol";
import type { ProviderId } from "../types";

/**
 * The provider half of a `provider/model` id, or null when it has no provider.
 *
 * `parseModelId` THROWS on an id without a `/`, and sessions in the wild carry
 * bare or empty model ids — so a client asking "what is this session running?"
 * would get a dispatch error instead of an answer. Here the caller falls back
 * to the session's recorded provider instead.
 */
function providerOfModel(modelId: string): string | null {
    try {
        return parseModelId(modelId).provider;
    } catch {
        return null;
    }
}

/** Refusal text for a local-only method reached over the network. */
function localOnlyError(method: string): Error {
    return new Error(`${method} is not available over ${PRODUCT_NAME} serve — artifacts stay on the local machine`);
}

/**
 * One artifact, as the wire sees it: the stored metadata plus the two things a
 * client would otherwise have to reconstruct — where the file is, and the URL
 * that opens it. Artifacts are served from disk rather than over HTTP (see
 * artifacts/index.ts), so `url` is a file:// URL and `path` is what a desktop
 * shell hands to the OS.
 */
function artifactRow(meta: ArtifactMeta): Record<string, unknown> {
    const path = artifactFilePath(meta);
    return { ...meta, path, url: pathToFileURL(path).href };
}

/** Every method `dispatch` handles — surfaced via `server.info`. Keep in sync. */
const RPC_METHODS = [
    "server.info",
    "session.create",
    "session.list",
    "session.history",
    "session.open",
    "session.send",
    "session.cancel",
    "session.compact",
    "session.rename",
    "session.attach",
    "session.detach",
    "session.delete",
    "session.answer",
    "session.tree",
    "session.branch",
    "session.fork",
    "session.archive",
    "agent.list",
    "agent.get",
    "agent.save",
    "agent.delete",
    "agent.tools",
    "auth.status",
    "auth.providers",
    "auth.login",
    "auth.logout",
    "auth.flow.start",
    "auth.flow.poll",
    "auth.flow.answer",
    "auth.flow.cancel",
    "auth.custom.list",
    "auth.custom.discover",
    "auth.custom.save",
    "auth.custom.remove",
    "auth.custom.setActive",
    "catalog.list",
    "cost.session",
    "cost.lifetime",
    "cost.stats",
    "usage.steak",
    "settings.list",
    "settings.set",
    "config.reload",
    "context.report",
    "extension.list",
    "extension.setEnabled",
    "mcp.list",
    "mcp.add",
    "mcp.remove",
    "mcp.setEnabled",
    "mcp.reconnect",
    "mcp.login.start",
    "mcp.login.poll",
    "mcp.login.cancel",
    "datasource.list",
    "datasource.save",
    "datasource.remove",
    "datasource.test",
    "git.commitMessage",
    "artifact.list",
    "artifact.get",
    "artifact.read",
    "artifact.export",
    "artifact.delete",
] as const;

/**
 * Settings a remote client may read and toggle — the boolean rows of the
 * TUI's /settings screen. An allowlist (not a passthrough) so the RPC surface
 * can't write arbitrary keys; terminal-only toggles (clock, theme…) and
 * structured settings (hooks, sandbox…) stay local.
 */
const WEB_SETTINGS: ReadonlyArray<{ key: keyof AppSettings; label: string; description: string; def: boolean }> = [
    { key: "subagents", label: "subagents", description: "task tool: delegate work to parallel subagents", def: true },
    { key: "memory", label: "memory", description: "agent saves per-project facts across sessions", def: true },
    { key: "skills", label: "skills", description: "let the agent load project skills", def: true },
    { key: "recap", label: "recap", description: "short AI recap under responses that changed files", def: false },
    {
        key: "webSearch",
        label: "websearch",
        description: "websearch tool (DuckDuckGo scrape, may rate-limit)",
        def: false,
    },
    { key: "todos", label: "todos", description: "visible checklist during multi-step tasks", def: false },
    {
        key: "backgroundShells",
        label: "background shells",
        description: "let bash start servers/watchers that keep running after the tool call",
        def: false,
    },
    {
        key: "artifacts",
        label: "artifacts",
        description: "let the agent publish documents it writes as pages you can open",
        def: false,
    },
    { key: "reminders", label: "reminders", description: "fire /reminder alerts", def: true },
    {
        key: "mcp",
        label: "mcp servers",
        description: "connect configured MCP servers and expose their tools",
        def: true,
    },
    {
        key: "serve",
        label: "serve (web UI)",
        description: "allow loop serve — turning this off blocks the NEXT serve start",
        def: false,
    },
];

/**
 * Which session's turn is currently running, for the ask bridge.
 *
 * The bridge is a single global (core cannot depend on a UI), but a question
 * has to reach the client watching THAT session — and several sessions can be
 * mid-turn at once. A module variable would answer whichever turn started
 * last; async-local storage follows the actual call, including through every
 * await inside runTurn.
 */
const askSession = new AsyncLocalStorage<string>();

/** Events kept per active session for reconnect replay (session.attach). */
const EVENT_RING_SIZE = 2048;

/** Turn events whose payload can carry a thrown Error. See plainError. */
const ERROR_BEARING_EVENTS = new Set(["error", "tool-error"]);

/**
 * An Error, turned into something that survives leaving this process.
 *
 * `JSON.stringify(new Error("boom"))` is `{}` — `message`, `name` and `stack`
 * are all non-enumerable — so every failure this stream carried reached a
 * client as an empty object. MEASURED against the desktop app: a `write` that
 * threw rendered a red row whose entire detail was `{}`, and a 401 from the
 * provider ended the turn with a banner that said nothing at all. The TUI
 * never noticed because it holds the Error itself and runs `formatError` on
 * it; anything crossing the wire has to be made of plain data first.
 *
 * The enumerable own properties are kept alongside the message because that is
 * where the AI SDK puts what matters — `statusCode`, `responseBody`, `data` —
 * and a client's own formatter reads them to turn a 401 into "invalid
 * x-api-key". `stack` is deliberately dropped: it is noise in a UI and the
 * biggest field on the object.
 */
export function plainError(value: unknown, depth = 0): unknown {
    if (depth > 4) return undefined;
    if (value instanceof Error) {
        const error = value as Error & Record<string, unknown>;
        const out: Record<string, unknown> = { name: error.name, message: error.message };
        for (const [key, entry] of Object.entries(error)) {
            if (key === "stack") continue;
            out[key] = entry;
        }
        // Non-enumerable on a native Error, and where node/bun bury the real
        // syscall failure (ECONNREFUSED under a vague fetch message).
        if (error.cause !== undefined) out.cause = plainError(error.cause, depth + 1);
        return out;
    }
    if (Array.isArray(value)) return value.map((entry) => plainError(entry, depth + 1));
    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(source)) out[key] = plainError(entry, depth + 1);
        return out;
    }
    return value;
}

interface RingEntry {
    seq: number;
    part: { type: string; data: unknown };
}

interface ActiveSession {
    session: Session;
    tracker: CostTracker;
    abort: AbortController;
    emitter: EventEmitter;
    modelId: string;
    /** True while a turn (or compact) is running — concurrent sends on the
     * same session would interleave appends and corrupt the branch. */
    running: boolean;
    /** Transports receiving this session's events. Events broadcast to all;
     * input (send/cancel) is accepted from any of them. */
    subscribers: Set<Transport>;
    /** Monotonic per-session event counter; stamped on every session.event. */
    seq: number;
    /** Last EVENT_RING_SIZE events, for session.attach {afterSeq} replay. */
    ring: RingEntry[];
}

type Transport = {
    send(msg: RpcResponse | RpcNotification): void;
};

/**
 * One RPC method's implementation. Every handler takes the same three
 * arguments so the groups compose into one table; a handler names only the
 * ones it uses.
 */
type RpcMethodHandler = (
    params: Record<string, unknown>,
    transport: Transport,
    req: RpcRequest,
) => unknown;

export class RpcServer {
    private sessions = new Map<string, ActiveSession>();
    private manager = new SessionManager();
    private commands = new CommandRegistry();
    /**
     * True when this server is reachable over the network (`loop serve`) rather
     * than only over the local unix socket / stdio.
     *
     * Only artifacts care so far, and deliberately: an artifact is a page the
     * agent wrote out of the contents of your repo, and `serve` binds 0.0.0.0
     * by default. Refusing the whole `artifact.*` family here means those bytes
     * never cross the network at all, which is a stronger guarantee than a UI
     * that merely declines to render them.
     */
    private readonly remote: boolean;
    /** Startup work (extensions, command registry) every request waits on —
     * otherwise an early session.send could run a turn before extension
     * tools/providers exist. */
    private ready: Promise<void>;

    /** askId -> the tool call waiting on `session.answer`. */
    private pendingAsks = new Map<string, (answers: AskAnswer[]) => void>();
    private nextAskId = 1;

    /** Throw unless this server is the local one. See `remote`. */
    private requireLocal(method: string): void {
        if (this.remote) throw localOnlyError(method);
    }

    constructor(opts: { remote?: boolean } = {}) {
        this.remote = opts.remote === true;
        // Registering a bridge is what makes the ask tool exist at all: runTurn
        // only attaches it when one is present, which is why RPC clients never
        // saw a question before.
        setAskUserBridge({
            ask: (questions, opts) => this.askOverRpc(questions, opts),
        });
        this.ready = (async () => {
            await getExtensionHost().init();
            await registerBuiltins(this.commands);
            getExtensionHost().applyCommands(this.commands);
        })();
    }

    /**
     * Put a question to whichever client is watching this session.
     *
     * Declining is the safe default everywhere: no session context, nobody
     * subscribed, or the turn aborted all resolve as "declined" rather than
     * hanging the turn on an answer that can never arrive. The tool then tells
     * the model to proceed without asking.
     */
    private askOverRpc(questions: AskQuestion[], opts?: { signal?: AbortSignal }): Promise<AskAnswer[]> {
        const declined = (): AskAnswer[] => questions.map(() => ({ answers: [], declined: true }));
        const sessionId = askSession.getStore();
        const ctx = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!sessionId || !ctx || ctx.subscribers.size === 0) return Promise.resolve(declined());

        const askId = `ask-${this.nextAskId++}`;
        return new Promise<AskAnswer[]>((resolve) => {
            let settled = false;
            const finish = (answers: AskAnswer[]) => {
                if (settled) return;
                settled = true;
                this.pendingAsks.delete(askId);
                opts?.signal?.removeEventListener("abort", onAbort);
                resolve(answers);
            };
            const onAbort = () => finish(declined());
            if (opts?.signal?.aborted) return finish(declined());
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            this.pendingAsks.set(askId, finish);
            // Rides the same event channel as the turn stream, so a client
            // already rendering the turn needs no second subscription.
            this.broadcast(sessionId, ctx, { type: "ask", data: { askId, questions } });
        });
    }

    attach(transport: Transport): { feed: (chunk: Buffer | string) => void; close: () => void } {
        let buffer = "";
        const feed = (chunk: Buffer | string) => {
            buffer += typeof chunk === "string" ? chunk : chunk.toString();
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line) this.handleLine(line, transport);
            }
        };
        return { feed, close: () => this.disconnect(transport) };
    }

    /** Transport gone (socket/WS closed): stop broadcasting to it everywhere. */
    disconnect(transport: Transport): void {
        for (const ctx of this.sessions.values()) ctx.subscribers.delete(transport);
    }

    /**
     * The process hosting this server is going away.
     *
     * A transport closing is `disconnect`; this is the other end of the
     * lifetime — every live turn is aborted, every subscriber dropped, and
     * everything bash started is killed. That last part is the reason this
     * method exists: background shells are process-lifetime, held in an
     * in-memory registry, so a server that exits without killing them leaves
     * processes running that no future session can find. The CLI has always
     * done this on its way out; nothing else did.
     *
     * Idempotent — a surface may reach it from both a signal and a stream end.
     */
    dispose(): number {
        for (const ctx of this.sessions.values()) {
            ctx.abort.abort();
            ctx.subscribers.clear();
        }
        this.sessions.clear();
        return killAllBashChildren();
    }

    private async handleLine(line: string, transport: Transport): Promise<void> {
        let req: RpcRequest;
        try {
            req = JSON.parse(line) as RpcRequest;
        } catch {
            transport.send({
                jsonrpc: "2.0",
                id: null,
                error: { code: RpcErrorCode.PARSE_ERROR, message: "Parse error" },
            });
            return;
        }
        try {
            await this.ready;
            const result = await this.dispatch(req, transport);
            if (req.id !== undefined) {
                transport.send({ jsonrpc: "2.0", id: req.id, result });
            }
        } catch (err) {
            if (req.id !== undefined) {
                transport.send({
                    jsonrpc: "2.0",
                    id: req.id,
                    error: { code: RpcErrorCode.INTERNAL_ERROR, message: (err as Error).message },
                });
            }
        }
    }

    /**
     * The method table, built once on first dispatch.
     *
     * This used to be one 64-case switch, which meant a single 800-line method
     * and no way to see a domain's surface without scrolling past every other
     * one. The bodies are unchanged — each is now an arrow in the group its
     * method name belongs to, so `this` still means the server.
     */
    private methodHandlers: Record<string, RpcMethodHandler> | undefined;

    private get handlers(): Record<string, RpcMethodHandler> {
        this.methodHandlers ??= {
            ...this.sessionHandlers(),
            ...this.agentHandlers(),
            ...this.authHandlers(),
            ...this.catalogHandlers(),
            ...this.settingsHandlers(),
            ...this.extensionHandlers(),
            ...this.datasourceHandlers(),
            ...this.mcpHandlers(),
            ...this.artifactHandlers(),
        };
        return this.methodHandlers;
    }

    private async dispatch(req: RpcRequest, transport: Transport): Promise<unknown> {
        const handler = this.handlers[req.method];
        if (!handler) throw new Error(`Method not found: ${req.method}`);
        return handler((req.params ?? {}) as Record<string, unknown>, transport, req);
    }

    /** Sessions: create, open, send, and the tree they live in. */
    private sessionHandlers(): Record<string, RpcMethodHandler> {
        return {
            "session.create": async (params, transport) => {
                const cwd = String(params.cwd ?? process.cwd());
                const provider = (params.provider as ProviderId) ?? getActiveProvider() ?? "xai";
                const model = String(params.model ?? "");
                const session = await this.manager.create({ cwd, provider, model });
                const ctx: ActiveSession = {
                    session,
                    tracker: new CostTracker(),
                    abort: new AbortController(),
                    emitter: new EventEmitter(),
                    modelId: model,
                    running: false,
                    subscribers: new Set([transport]),
                    seq: 0,
                    ring: [],
                };
                this.wireCtx(session.id, ctx);
                this.sessions.set(session.id, ctx);
                return { sessionId: session.id };
            },
            "session.answer": (params) => {
                // Index-aligned with the questions the `ask` event carried.
                // Unknown id = the turn already moved on (aborted, or answered
                // by another client); say so rather than failing.
                const askId = String(params.askId ?? "");
                const resolve = this.pendingAsks.get(askId);
                if (!resolve) return { ok: false, askId };
                const answers = Array.isArray(params.answers) ? (params.answers as AskAnswer[]) : [];
                resolve(answers);
                return { ok: true, askId };
            },
            "session.list": (params) => {
                // DB rows enriched with liveness so pickers can mark sessions
                // that are running / being watched right now.
                //
                // `archived` selects which side of the archive to list: absent
                // or false is the working set (what every caller predating the
                // archive meant by "the sessions"), true is the archive,
                // "all" is both.
                const scope: SessionScope =
                    params.archived === "all"
                        ? "all"
                        : params.archived === true || params.archived === "true"
                          ? "archived"
                          : "active";
                return this.manager.list(params.cwd as string | undefined, scope).map((row) => {
                    const ctx = this.sessions.get(row.id);
                    // `model`/`provider` on the row are the session's CREATION
                    // model. `lastModel` is what it is actually running now, so
                    // a client that shows a model never contradicts /model.
                    const model = row.lastModel ?? row.model;
                    return {
                        ...row,
                        lastModel: model,
                        lastProvider: providerOfModel(model) ?? row.provider,
                        running: ctx?.running ?? false,
                        attached: ctx?.subscribers.size ?? 0,
                    };
                });
            },
            "session.history": async (params) => {
                // Full transcript along the current branch so a (re)connecting
                // client can render the conversation before subscribing to the
                // live stream. Abandoned branches are excluded — this is what
                // the model sees. Returns the current event seq so the client
                // can session.attach {afterSeq} without a gap.
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                // `info` is the session as CREATED, so info.model/provider are
                // whatever it started on. A GUI that pre-selects from those
                // silently undoes every /model switch, so the model actually in
                // force is reported alongside them.
                const model = ctx.session.lastModel();
                return {
                    sessionId: id,
                    info: ctx.session.info,
                    model,
                    provider: providerOfModel(model) ?? ctx.session.info.provider,
                    name: ctx.session.getName(),
                    leafId: ctx.session.getLeafId(),
                    entries: ctx.session.getBranch(),
                    seq: ctx.seq,
                    running: ctx.running,
                };
            },
            "session.open": async (params) => {
                // Reuses a live context: a second client opening the session
                // must NOT reset the running flag / abort controller of a turn
                // in flight. Does NOT subscribe — clients call session.attach
                // after rendering history, so no event can slip in between and
                // apply twice (or out of order).
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                return { sessionId: id, info: ctx.session.info, running: ctx.running, seq: ctx.seq };
            },
            "session.attach": async (params, transport) => {
                // Subscribe + catch up: replays ring events after `afterSeq`,
                // or signals resync when the gap left the ring (client falls
                // back to a full session.history render).
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                ctx.subscribers.add(transport);
                const afterSeq = params.afterSeq === undefined ? undefined : Number(params.afterSeq);
                let resync = false;
                if (afterSeq !== undefined && afterSeq < ctx.seq) {
                    const oldest = ctx.ring.length ? ctx.ring[0].seq : ctx.seq + 1;
                    if (afterSeq < oldest - 1) {
                        resync = true;
                    } else {
                        for (const entry of ctx.ring) {
                            if (entry.seq > afterSeq) {
                                transport.send({
                                    jsonrpc: "2.0",
                                    method: "session.event",
                                    params: { sessionId: id, seq: entry.seq, part: entry.part },
                                });
                            }
                        }
                    }
                } else if (afterSeq !== undefined && afterSeq > ctx.seq) {
                    // Client is ahead of us: the server restarted and the seq
                    // counter reset. Its transcript is stale — full resync.
                    resync = true;
                }
                return { ok: true, seq: ctx.seq, running: ctx.running, resync };
            },
            "session.detach": (params, transport) => {
                const id = String(params.sessionId);
                this.sessions.get(id)?.subscribers.delete(transport);
                return { ok: true };
            },
            "session.send": (params) => {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                if (ctx.running) throw new Error(`session ${id} already has a turn running (cancel it first)`);
                // Remote clients (web UI) attach images as base64 payloads: each
                // is written to a temp file and referenced with the same
                // [image:<path>] sentinel paste/drag produces in the TUI, so the
                // whole existing pipeline (extraction, transcript, replay)
                // applies unchanged.
                const input = String(params.input ?? "") + writeAttachmentPayloads(params.images);
                const modelId = String(params.model ?? ctx.modelId);
                // Per-send thinking override; anything unknown falls back to the
                // thinkingLevel setting (runTurn's own default).
                const thinking = THINKING_LEVELS.includes(params.thinking as ThinkingLevel)
                    ? (params.thinking as ThinkingLevel)
                    : undefined;
                // One-shot agent, the RPC form of `/<agent> <message>`: this
                // turn runs under that agent's prompt and the session is
                // untouched. An unknown name is refused rather than silently
                // falling back to the default persona, which would look like
                // the agent had simply ignored its instructions.
                const agent = typeof params.agent === "string" ? params.agent.trim() : "";
                if (agent && !agentExists(agent)) throw new Error(`Unknown agent: ${agent}`);
                ctx.modelId = modelId;
                this.setRunning(id, ctx, true);
                // run async; events stream via notifications
                // Inside askSession.run so the ask tool can tell which session
                // is asking — it follows the call through every await.
                void askSession.run(id, () =>
                    runTurn({
                        session: ctx.session,
                        modelId,
                        userInput: input,
                        cwd: ctx.session.info.cwd,
                        abortSignal: ctx.abort.signal,
                        tracker: ctx.tracker,
                        emitter: ctx.emitter,
                        thinkingLevel: thinking,
                        ...(agent ? { agent } : {}),
                    })
                        .catch((err) => {
                            // Same channel + shape as the emitter's "error" event, so a
                            // client has one error path to handle, not two. Broadcast
                            // (not just the sender): every watcher needs the turn end.
                            this.broadcast(id, ctx, { type: "error", data: String(err) });
                        })
                        .finally(() => {
                            this.setRunning(id, ctx, false);
                        }),
                );
                return { ok: true };
            },
            "session.rename": async (params) => {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                const name = String(params.name ?? "").trim();
                await ctx.session.setName(name);
                return { ok: true, name };
            },
            "session.cancel": (params) => {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                ctx.abort.abort();
                ctx.abort = new AbortController();
                return { ok: true };
            },
            "session.tree": async (params) => {
                // ALL branches, unlike `session.history`, which returns only
                // the current one. That is the right answer for rendering a
                // conversation and the wrong one for choosing between them —
                // and without this a client cannot even see that a session HAS
                // branches, let alone move between them.
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                return buildSessionTreeView(ctx.session);
            },
            "session.branch": (params) => {
                // `/tree` navigation: move the leaf, so the entries after it
                // stop reaching the model. Nothing is deleted — the abandoned
                // branch stays in the tree and can be navigated back to, which
                // is the whole reason a session is a tree.
                //
                // No branch summary. The TUI can offer to summarize what it is
                // leaving behind, which is a model call with its own cost and
                // failure modes; a client that wants it can send the summary
                // as the next message.
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                if (ctx.running) throw new Error(`session ${id} has a turn running (cancel it first)`);
                const entryId = params.entryId === null ? null : String(params.entryId ?? "");
                if (entryId === null || entryId === "") {
                    // Back to the very beginning: the next turn starts fresh
                    // with nothing but the session's own root.
                    ctx.session.resetLeaf();
                } else {
                    if (!ctx.session.getEntry(entryId)) throw new Error(`Unknown entryId: ${entryId}`);
                    ctx.session.branch(entryId);
                }
                // The model in force follows the branch — `lastModel` reads the
                // path, so a branch that ran on another model changes it.
                ctx.modelId = ctx.session.lastModel();
                return { ok: true, leafId: ctx.session.getLeafId(), model: ctx.modelId };
            },
            "session.fork": async (params) => {
                // A COPY, unlike session.branch, which moves this session's
                // leaf. `position` mirrors the TUI: "at" clones up to and
                // including the entry (/clone), "before" forks at its parent so
                // the entry itself is not carried (/fork on a user message —
                // the client puts its text back in the composer).
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                const position = params.position === "before" ? "before" : "at";
                const entryId = String(params.entryId ?? ctx.session.getLeafId() ?? "");
                if (entryId === "") throw new Error(`session ${id} has nothing to fork from`);
                const entry = ctx.session.getEntry(entryId);
                if (!entry) throw new Error(`Unknown entryId: ${entryId}`);

                let targetLeafId: string | null = entryId;
                if (position === "before") {
                    if (entry.type !== "message" || entry.role !== "user") {
                        throw new Error(`Only a user message can be forked "before": ${entryId}`);
                    }
                    targetLeafId = entry.parentId ?? null;
                }
                // Forking at the very first message has nothing to copy, so it
                // is a brand-new empty session in the same folder — the TUI
                // makes the same call.
                const forked = targetLeafId
                    ? this.manager.forkAtEntry(ctx.session, targetLeafId)
                    : await this.manager.create({
                          cwd: ctx.session.info.cwd,
                          provider: ctx.session.info.provider,
                          model: ctx.session.lastModel(),
                      });
                return {
                    sessionId: forked.info.id,
                    cwd: forked.info.cwd,
                    leafId: forked.getLeafId(),
                    // What the forked-from entry said, so a client forking
                    // "before" can put the prompt back in its composer without
                    // a second round trip.
                    text:
                        position === "before" && entry.type === "message"
                            ? stripSessionHookContext(extractMessageText(entry.content))
                            : undefined,
                };
            },
            "session.archive": (params) => {
                // The gentler half of `session.delete`: the conversation, its
                // entries and its spend all stay — it just stops appearing in
                // the list you work from. `archived: false` takes it back out.
                //
                // Like delete, deliberately NOT behind `requireSession`: most
                // of what you want to archive is exactly what this process has
                // never opened. Unlike delete, it does not refuse while a turn
                // is running — putting a conversation away does not disturb
                // it, and forcing you to stop the agent first would be
                // gratuitous.
                const id = String(params.sessionId);
                const archived = params.archived !== false;
                const ok = this.manager.setArchived(id, archived);
                return { ok, sessionId: id, archived: ok ? archived : false };
            },
            "session.delete": (params) => {
                // Deliberately does NOT go through requireSession: a session
                // that was never opened in this process has no live context,
                // and being unable to delete the ones you have not touched
                // would make the whole thing useless.
                const id = String(params.sessionId);
                const ctx = this.sessions.get(id);
                if (ctx?.running) {
                    throw new Error(`session ${id} has a turn running (cancel it first)`);
                }
                if (ctx) {
                    // Drop the live context first, or subscribers keep a
                    // handle on a conversation whose rows are gone.
                    ctx.abort.abort();
                    ctx.subscribers.clear();
                    this.sessions.delete(id);
                }
                // Shells belong to the session. Deleting it is the one moment
                // they become unreachable — the registry is keyed by session
                // id, so a shell left running here can never be listed, read
                // or killed again by anyone.
                killSessionShells(id);
                const deleted = this.manager.delete(id);
                return { ok: deleted, sessionId: id };
            },
            "session.compact": async (params) => {
                const id = String(params.sessionId);
                const ctx = this.requireSession(id);
                if (ctx.running) throw new Error(`session ${id} already has a turn running (cancel it first)`);
                this.setRunning(id, ctx, true);
                // Announced on the same event stream the turn uses, and for the
                // same reason auto-compaction announces itself in runTurn: a
                // compaction rewrites what the conversation IS, and a client
                // that only sees the return value has no way to show that it
                // happened, or that it is happening — this call can take tens
                // of seconds. `manual` matches the CLI's own /compact trigger.
                this.broadcast(id, ctx, { type: "compact-start", data: { reason: "manual" } });
                try {
                    const result = await runCompact({
                        session: ctx.session,
                        modelId: ctx.modelId,
                        keepTurns: 0,
                        tracker: ctx.tracker,
                        cwd: ctx.session.info.cwd,
                    });
                    this.broadcast(id, ctx, { type: "compact-end", data: result });
                    return result;
                } catch (err) {
                    // A failed compaction must still close the event, or a
                    // client renders "Compacting…" forever.
                    this.broadcast(id, ctx, {
                        type: "compact-end",
                        data: { summary: "", cutAt: 0, tokensBefore: 0, tokensAfter: 0, aborted: true },
                    });
                    throw err;
                } finally {
                    this.setRunning(id, ctx, false);
                }
            },
        };
    }

    /** Named agents and the tools each may use. */
    private agentHandlers(): Record<string, RpcMethodHandler> {
        return {
            "agent.list": () => {
                // Name, description and model only: `prompt` can be pages long
                // and no client needs it to render a picker.
                return listAgents()
                    .filter((a) => !a.hidden)
                    .map((a) => ({
                        name: a.name,
                        builtin: a.builtin,
                        ...(a.model === undefined ? {} : { model: a.model }),
                        ...(a.tools === undefined ? {} : { tools: a.tools }),
                    }));
            },
            "agent.get": (params) => {
                // The editor's read: unlike agent.list this DOES carry the
                // prompt, because editing it is the whole point. Hidden
                // built-ins are fetchable by name — they are only hidden from
                // the picker, not secret.
                const name = String(params.name ?? "");
                if (!agentExists(name)) throw new Error(`Unknown agent: ${name}`);
                const builtin = isBuiltinAgent(name);
                return {
                    name,
                    prompt: getAgentPrompt(name) ?? "",
                    builtin,
                    // Undefined means "all tools" — kept as an absent field so
                    // a client can tell it apart from an empty allowlist.
                    ...(getAgentTools(name) === undefined ? {} : { tools: getAgentTools(name) }),
                    ...(getAgentModel(name) === undefined ? {} : { model: getAgentModel(name) }),
                    // A built-in's tool set is fixed; only its prompt and model
                    // are editable, and `hasOverride` is what makes "reset to
                    // built-in" offerable.
                    toolsEditable: !builtin,
                    hasOverride: hasBuiltinOverride(name),
                };
            },
            "agent.save": (params) => {
                // Create or update. Mirrors the TUI's /agents editor, including
                // its rule that a built-in's tool set is fixed (saveAgent drops
                // `tools` for built-ins rather than trusting the caller).
                const name = String(params.name ?? "").trim();
                if (!isValidAgentName(name)) {
                    throw new Error(`Invalid agent name: ${name} (alphanumeric and dashes, 32 chars max)`);
                }
                const prompt = String(params.prompt ?? "");
                if (!prompt.trim()) throw new Error("An agent needs a system prompt");
                // A name that is already a slash command but not an agent would
                // produce an agent nobody can invoke — the TUI refuses it too.
                if (!agentExists(name) && this.commands.has(name)) {
                    throw new Error(`"${name}" is already a command`);
                }
                const tools = Array.isArray(params.tools) ? (params.tools as unknown[]).map(String) : undefined;
                const model = typeof params.model === "string" ? params.model : undefined;
                saveAgent(name, prompt, tools, model);
                return { ok: true, name };
            },
            "agent.delete": (params) => {
                // For a custom agent this removes it; for a built-in it drops
                // the override file, resetting the prompt. `{ok:false}` means
                // there was no file — nothing to reset — not an error.
                const name = String(params.name ?? "");
                return { ok: deleteAgent(name) };
            },
            "agent.tools": () => {
                // The allowlist an agent editor offers. Dynamic, not the static
                // constant, so tools registered by extensions are offerable.
                return agentToolNames();
            },
        };
    }

    /** Provider sign-in: status, the device/OAuth flows, custom gateways. */
    private authHandlers(): Record<string, RpcMethodHandler> {
        return {
            "auth.status": async () => {
                // `providers` is what a remote client may OFFER, which includes
                // the zero-login (ollama, bedrock) and custom gateways that have
                // no auth entry — returning only logged-in providers here is
                // what made them vanish from the Telegram and web pickers.
                // `authorized` keeps the strict "has stored credentials" set.
                return {
                    providers: await listUsableProviders(),
                    authorized: listAuthorizedProviders(),
                    active: getActiveProvider(),
                };
            },
            // Every provider a client may OFFER TO SIGN IN TO — wider than
            // auth.status, which only answers "what can run now". A settings
            // screen needs the ones you could connect, or it has nothing to
            // show but the providers you already have.
            "auth.providers": () => {
                return { providers: listProviderDescriptors(), active: getActiveProvider() };
            },
            "auth.login": (params) => {
                const provider = params.provider as ProviderId;
                const key = String(params.apiKey ?? "");
                if (!provider || !key) {
                    throw new Error("provider and apiKey required");
                }
                loginApiKey(provider, key);
                // A key changes which models are available, and the catalog is
                // cached — without this the new provider's models would not
                // appear until the process restarted.
                bustCatalogCache();
                return { ok: true };
            },
            "auth.logout": (params) => {
                const provider = params.provider as ProviderId | undefined;
                logout(provider);
                if (provider && isCustomProvider(provider)) {
                    deleteCustomProvider(parseCustomProviderId(provider)!);
                }
                bustCatalogCache();
                return { ok: true };
            },
            // The logins a request/response cannot hold open — OAuth, device
            // flows, credential probes. See rpc/auth-flows.ts.
            "auth.flow.start": (params) => {
                return startAuthFlow({
                    provider: String(params.provider ?? ""),
                    ...(params.method ? { method: params.method as AuthMethod } : {}),
                    // An unsaved gateway signs in from its draft — see
                    // rpc/custom-providers.ts.
                    ...(params.custom === undefined ? {} : { custom: params.custom }),
                });
            },
            "auth.flow.poll": (params) => {
                return pollAuthFlow(String(params.flowId ?? ""), Number(params.cursor ?? 0));
            },
            "auth.flow.answer": (params) => {
                return answerAuthFlow(
                    String(params.flowId ?? ""),
                    String(params.promptId ?? ""),
                    String(params.value ?? ""),
                );
            },
            "auth.flow.cancel": (params) => {
                return cancelAuthFlow(String(params.flowId ?? ""));
            },
            // Creating a gateway, which `auth.login` cannot do: it stores a key
            // against a provider that already exists, and a custom provider IS
            // its config. See rpc/custom-providers.ts.
            "auth.custom.list": () => {
                return listCustomProviderSummaries();
            },
            "auth.custom.discover": async (params) => {
                return await discoverCustomProviderModels(params);
            },
            "auth.custom.save": (params) => {
                return saveCustomProviderConfig(params);
            },
            "auth.custom.remove": (params) => {
                return removeCustomProvider(params);
            },
            "auth.custom.setActive": (params) => {
                return setActiveCustomProvider(params);
            },
        };
    }

    /** Models, what a run cost, and the message a commit gets. */
    private catalogHandlers(): Record<string, RpcMethodHandler> {
        return {
            "catalog.list": async (params) => {
                const cat = await getCatalog();
                const wanted = params.provider as ProviderId | undefined;
                const list = Object.values(cat);
                return wanted ? list.filter((m) => m.provider === wanted) : list;
            },
            "cost.session": async (params) => {
                // `ensureCtx`, not `requireSession`: what a session cost is a
                // property of the transcript, not of whether this process
                // happens to have it open. Refusing to answer for a session
                // resumed in another window made the number unusable in a GUI.
                const id = String(params.sessionId);
                const ctx = await this.ensureCtx(id);
                return ctx.tracker.sessionBreakdown();
            },
            "cost.lifetime": () => {
                const tracker = new CostTracker();
                return tracker.lifetimeBreakdown();
            },
            "git.commitMessage": async (params) => {
                // Sessionless on purpose: the desktop commit dialog wants one
                // subject line for a diff it already has, and opening a session
                // to get it would litter the session list and the tree.
                const diff = String(params.diff ?? "");
                if (!diff.trim()) return { message: "" };
                const modelId = String(params.model ?? getSetting("defaultModel") ?? "");
                if (!modelId) throw new Error("no model configured to write a commit message");
                const message = await generateCommitMessage({
                    diff,
                    modelId,
                    branch: params.branch ? String(params.branch) : undefined,
                    tracker: new CostTracker(),
                    cwd: params.cwd ? String(params.cwd) : undefined,
                });
                return { message };
            },
            "cost.stats": (params) => {
                // today/7d/month/lifetime USD + per-provider split; cwd bucket
                // when the client passes one (the web UI's selected project).
                const tracker = new CostTracker();
                return tracker.stats(params.cwd ? String(params.cwd) : undefined);
            },
            "usage.steak": (params) => {
                // The /steak heatmap, computed server-side with the exact CLI
                // layout (buildSteakGrid) so every client shades identically.
                const year = params.year !== undefined ? Number(params.year) : undefined;
                const daily = this.manager.dailyTokens();
                return buildSteakGrid(daily, Number.isInteger(year) ? { year } : {});
            },
        };
    }

    /** Settings, the context report, and what this server is. */
    private settingsHandlers(): Record<string, RpcMethodHandler> {
        return {
            "settings.list": () => {
                return WEB_SETTINGS.map((s) => ({
                    key: s.key,
                    label: s.label,
                    description: s.description,
                    value: (getSetting(s.key) as boolean | undefined) ?? s.def,
                }));
            },
            "context.report": async (params) => {
                // The /context breakdown for an open session, or — for a draft
                // (no session yet) — the fixed overhead a new session in that
                // cwd would start with. Read-only; buildContextReport mutates
                // nothing.
                if (params.sessionId) {
                    const ctx = await this.ensureCtx(String(params.sessionId));
                    return buildContextReport({
                        session: ctx.session,
                        modelId: ctx.modelId,
                        cwd: ctx.session.info.cwd,
                    });
                }
                const model = String(params.model ?? getSetting("defaultModel") ?? "");
                return buildContextReport({
                    session: null,
                    modelId: model,
                    cwd: String(params.cwd ?? process.cwd()),
                });
            },
            "config.reload": async (params) => {
                // The GUI's `/reload`, and the same act as the terminal's: every
                // config surface re-read from disk and the model catalog
                // re-fetched, in one round trip.
                //
                // Editing settings.json (or an agent, or an MCP entry) by hand
                // was invisible to a running server — CachedStore serves reads
                // from memory and the catalog is cached for the process — so the
                // only way to pick an edit up was to restart the app. Now it is
                // a call.
                //
                // Deliberately NOT here: the session's own model/agent choice.
                // A reload refreshes what the app knows, it does not re-decide
                // what an open conversation is running.
                //
                // All three JSON stores, not just settings: auth.json (custom
                // providers) and datasources.json are hand-editable too, and the
                // internal docs tell the agent to write them and then ask for a
                // reload.
                refreshConfigStores();
                // Datasource pools are keyed by connectionId, so an edited
                // host/password would keep dialing the old one until restart.
                await closeAllPools();

                const reloadCwd = String(params.cwd ?? process.cwd());

                // Prompts, skills and agents are read from disk at registration,
                // so the registry is rebuilt rather than mutated. Extension
                // command contributions are re-applied on top, exactly as the
                // constructor does, or a reload would silently drop them.
                const fresh = new CommandRegistry();
                await registerBuiltins(fresh, { cwd: reloadCwd });
                getExtensionHost().applyCommands(fresh);
                this.commands = fresh;

                bustCatalogCache();
                const catalog = await getCatalog({ refresh: true });

                // MCP: close resets the manager's `initialized` flag (init() is
                // a no-op once connected), so added/removed/edited servers are
                // actually re-read rather than the old connections being kept.
                await getMcpManager().close();
                await getMcpManager().init(reloadCwd);

                const models = Object.values(catalog);
                return {
                    models: models.length,
                    availableModels: models.filter((m) => m.available).length,
                    commands: this.commands.list().length,
                    agents: listAgents().length,
                    providers: (await listUsableProviders()).length,
                };
            },
            "settings.set": (params) => {
                const key = String(params.key);
                const entry = WEB_SETTINGS.find((s) => s.key === key);
                if (!entry) throw new Error(`setting not writable over RPC: ${key}`);
                if (typeof params.value !== "boolean") throw new Error("value must be boolean");
                setSetting(entry.key, params.value as never);
                return { key, value: params.value };
            },
            "server.info": () => {
                // Capabilities handshake: lets a client discover the methods and
                // event types this server speaks without version-sniffing.
                // `defaults` saves a remote client (which has no local settings)
                // from guessing a model/cwd for session.create.
                return {
                    protocol: "2.0",
                    methods: RPC_METHODS,
                    // The turn stream plus what the SERVER itself reports about
                    // a turn. `session-running` has no emitter behind it — it
                    // is this server's own flag (see `setRunning`) — so it
                    // cannot live in the build-checked TurnEvents list, but a
                    // client discovering capabilities still has to see it.
                    events: [...TURN_EVENT_NAMES, "session-running"],
                    defaults: {
                        model: getSetting("defaultModel") ?? null,
                        cwd: process.cwd(),
                        // The level a turn runs at when `session.send` omits
                        // `thinking` — runTurn's own fallback. A GUI effort
                        // picker has to start on this or it would silently
                        // override what the user set with /thinking.
                        thinking: getSetting("thinkingLevel") ?? "off",
                    },
                };
            },
        };
    }

    /** Extensions. */
    private extensionHandlers(): Record<string, RpcMethodHandler> {
        return {
            "extension.list": () => {
                return getExtensionHost().listAll();
            },
            "extension.setEnabled": async (params) => {
                // Enable/disable only — install/uninstall stay local-only, a
                // remote client must not be able to pull new code onto the box.
                const name = String(params.name ?? "");
                if (typeof params.value !== "boolean") throw new Error("value must be boolean");
                const entry = getExtensionHost()
                    .listAll()
                    .find((e) => e.name === name);
                if (!entry) throw new Error(`unknown extension: ${name}`);
                if (entry.builtin) setBuiltinEnabled(name, params.value);
                else setRecordEnabled(name, params.value);
                const host = getExtensionHost();
                if (params.value) await host.reload(name);
                else await host.unload(name);
                bustCatalogCache();
                return { name, value: params.value };
            },
        };
    }

    /** SQL datasources. */
    private datasourceHandlers(): Record<string, RpcMethodHandler> {
        return {
            /**
             * Saved database connections, with the secret withheld.
             *
             * `loop serve` is reachable over a network, so a stored password
             * must never ride a list response — the client only needs to know
             * whether one is set, and to render it if it is a `${env:VAR}`
             * reference, which is a pointer rather than a secret.
             */
            "datasource.list": () => {
                return listDatasources().map(({ id, config }) => {
                    const { password, ...rest } = config;
                    const isRef = typeof password === "string" && password.startsWith("${env:");
                    return {
                        id,
                        config: { ...rest, ...(isRef ? { password } : {}) },
                        hasPassword: Boolean(password),
                        passwordIsEnvRef: isRef,
                    };
                });
            },
            "datasource.save": async (params) => {
                const id = String(params.id ?? "").trim();
                if (!isValidConnectionId(id)) throw new Error(`invalid connection id: ${id}`);
                const draft = parseDatasourceConfig(params.config);
                /**
                 * An omitted password KEEPS the stored one.
                 *
                 * The list above withholds it, so an edit form has nothing to
                 * send back — and treating that silence as "clear the password"
                 * would break the connection every time someone corrected a
                 * port. Clearing is still possible, by sending an empty string.
                 */
                const existing = getDatasource(id);
                const config: DataSourceConfig =
                    draft.password === undefined && existing?.password !== undefined
                        ? { ...draft, password: existing.password }
                        : draft;
                saveDatasource(id, config);
                // The cached pool still holds the OLD credentials; leaving it
                // would mean the next query silently used the config the user
                // just replaced.
                await closePool(id);
                return { id };
            },
            "datasource.remove": async (params) => {
                const id = String(params.id ?? "").trim();
                const removed = deleteDatasource(id);
                if (removed) await closePool(id);
                return { ok: removed };
            },
            /**
             * Probe a connection without saving it.
             *
             * Takes either a draft config (the form's current contents, before
             * the user commits) or the id of a saved one. A draft that omits
             * its password falls back to the saved secret, so "Test" works on
             * an edit form that never received it.
             */
            "datasource.test": async (params) => {
                const id = typeof params.id === "string" ? params.id.trim() : "";
                if (params.config === undefined) {
                    const saved = id ? getDatasource(id) : undefined;
                    if (!saved) throw new Error(`unknown datasource: ${id || "(none)"}`);
                    return await testConnection(saved);
                }
                const draft = parseDatasourceConfig(params.config);
                const existing = id ? getDatasource(id) : undefined;
                return await testConnection(
                    draft.password === undefined && existing?.password !== undefined
                        ? { ...draft, password: existing.password }
                        : draft,
                );
            },
        };
    }

    /** MCP servers and their sign-in flows. */
    private mcpHandlers(): Record<string, RpcMethodHandler> {
        return {
            "mcp.list": (params) => {
                return listMcpServers(String(params.cwd ?? process.cwd()));
            },
            "mcp.add": async (params) => {
                // Scope matters: a project server lives in the repo's own file
                // and travels with it, a global one in ~/<config>/settings.json.
                // The manager only knows the global half, so a project add is
                // written and then picked up by the reconnect below.
                const name = String(params.name ?? "").trim();
                if (!name) throw new Error("server name required");
                const config = parseServerConfig(params.config);
                const cwd = String(params.cwd ?? process.cwd());
                if (params.scope === "project") {
                    addProjectServer(cwd, name, config);
                    await getMcpManager().adopt(name, config);
                } else {
                    await getMcpManager().add(name, config);
                }
                return { name, server: getMcpManager().getServer(name) ?? null };
            },
            "mcp.remove": async (params) => {
                const name = String(params.name ?? "").trim();
                const cwd = String(params.cwd ?? process.cwd());
                if (params.scope === "project") {
                    // The live connection has to go too, or its tools stay in
                    // the agent's tool set for the rest of the process.
                    const removed = removeProjectServer(cwd, name);
                    if (removed) await getMcpManager().forget(name);
                    return { ok: removed };
                }
                return { ok: await getMcpManager().remove(name) };
            },
            "mcp.setEnabled": async (params) => {
                const name = String(params.name ?? "").trim();
                if (typeof params.value !== "boolean") throw new Error("value must be boolean");
                const cwd = String(params.cwd ?? process.cwd());
                if (params.scope === "project") {
                    const ok = setProjectServerEnabled(cwd, name, params.value);
                    if (!ok) return { ok };
                    const config = getProjectServers(cwd)[name];
                    if (config) await getMcpManager().adopt(name, config);
                    return { ok };
                }
                return { ok: await getMcpManager().setEnabled(name, params.value) };
            },
            "mcp.reconnect": async (params) => {
                // No name = all of them. This is also what makes the first
                // `mcp.list` meaningful: nothing connects until asked.
                const name = String(params.name ?? "").trim();
                const cwd = String(params.cwd ?? process.cwd());
                const manager = getMcpManager();
                await manager.init(cwd);
                // `init` captures cwd once and is a no-op ever after, so a
                // client that has moved (another workspace, a different tab)
                // was reconnecting against the directory this process started
                // in — wrong project file, wrong trust decision.
                await manager.setCwd(cwd);
                await manager.reconnect(name || undefined);
                return listMcpServers(cwd);
            },
            "mcp.login.start": (params) => {
                return startMcpLogin(String(params.name ?? ""), String(params.cwd ?? process.cwd()));
            },
            "mcp.login.poll": (params) => {
                return pollMcpLogin(String(params.flowId ?? ""), Number(params.cursor ?? 0));
            },
            "mcp.login.cancel": (params) => {
                return cancelMcpLogin(String(params.flowId ?? ""));
            },
        };
    }

    /** Artifacts the agent published. */
    private artifactHandlers(): Record<string, RpcMethodHandler> {
        return {
            // Artifacts: pages the agent wrote under ~/<config>/artifacts. The
            // rows carry `path` and `url` so a client can open one without a
            // second round trip — there is no HTTP route serving artifacts, by
            // design, so the file itself is what gets opened.
            "artifact.list": (_params, _transport, req) => {
                this.requireLocal(req.method);
                return listArtifacts().map(artifactRow);
            },
            "artifact.get": (params, _transport, req) => {
                this.requireLocal(req.method);
                const meta = getArtifact(String(params.id));
                if (!meta) throw new Error(`no such artifact: ${params.id}`);
                return artifactRow(meta);
            },
            "artifact.read": (params, _transport, req) => {
                this.requireLocal(req.method);
                // The bytes, for a client that renders an artifact itself rather
                // than pointing a browser at the file — the desktop app's viewer
                // reads markdown/json/csv/text this way, since a renderer in the
                // page cannot open a file:// URL.
                const meta = getArtifact(String(params.id));
                if (!meta) throw new Error(`no such artifact: ${params.id}`);
                if (!meta.written) throw new Error(`artifact ${meta.id} has no content yet`);
                return { ...artifactRow(meta), content: readArtifact(meta.id) };
            },
            "artifact.export": (params, _transport, req) => {
                this.requireLocal(req.method);
                // Copies the artifact into a real folder (~/Downloads unless
                // asked otherwise) and reports where — the client has no
                // filesystem of its own, so the path is the whole answer.
                const dest = typeof params.dest === "string" ? params.dest : undefined;
                return { path: exportArtifact(String(params.id), dest) };
            },
            "artifact.delete": (params, _transport, req) => {
                this.requireLocal(req.method);
                return { deleted: deleteArtifact(String(params.id)) };
            },
        };
    }
    private requireSession(id: string): ActiveSession {
        const ctx = this.sessions.get(id);
        if (!ctx) throw new Error(`Unknown sessionId: ${id}`);
        return ctx;
    }

    /** Live context for a session, loading it from the store on first touch.
     * Reuse is the point: a reload/second client must see the same running
     * flag, abort controller, and event ring as the turn already in flight. */
    private async ensureCtx(id: string): Promise<ActiveSession> {
        const existing = this.sessions.get(id);
        if (existing) return existing;
        const session = await this.manager.open(id);
        // Seeded, not empty. `cost.session` reads this tracker, so an unseeded
        // one reports $0 for a conversation that has cost real money — the
        // client cannot tell "free" from "reopened". This is what the TUI does
        // on resume (`seedFromSession`), and it reads the ledger, so the total
        // is what was actually billed rather than a recompute.
        const tracker = new CostTracker();
        try {
            tracker.seedFromSession(session);
        } catch {
            // A tracker that cannot be seeded still bills this process's turns
            // correctly; refusing to open the session would be worse.
        }
        const ctx: ActiveSession = {
            session,
            tracker,
            abort: new AbortController(),
            emitter: new EventEmitter(),
            // The model it last RAN on, not the one it was created with — a
            // `session.send` that omits `model` should continue the session,
            // not silently revert it to whatever it started on.
            modelId: session.lastModel(),
            running: false,
            subscribers: new Set(),
            seq: 0,
            ring: [],
        };
        this.wireCtx(id, ctx);
        this.sessions.set(id, ctx);
        return ctx;
    }

    /**
     * Move the turn-running flag AND tell everyone watching.
     *
     * `ctx.running` is the only authority on whether this server is executing a
     * turn — it is set here and cleared in a `finally`, so unlike the `finish`
     * event it cannot be skipped by a throw, an abort or a dropped socket. It
     * was, however, only ever readable by ASKING (`session.list`,
     * `session.attach`, `session.history`): the flag flipped in silence.
     *
     * That silence is what left clients guessing. A UI cannot poll a boolean it
     * needs to render at 60fps, so the desktop reconstructed it from `finish`
     * instead and layered a quiet-for-six-seconds watchdog underneath to catch
     * the times that never arrived — two derived guesses standing in for a fact
     * the server had all along. Announcing the transition costs one event per
     * turn and makes "is it still working" something a client is TOLD.
     *
     * Idempotent by design: callers may re-assert the state they are already in
     * (an abort racing a natural finish does exactly that) and only real
     * transitions reach the wire.
     */
    private setRunning(sessionId: string, ctx: ActiveSession, running: boolean): void {
        if (ctx.running === running) return;
        ctx.running = running;
        this.broadcast(sessionId, ctx, { type: "session-running", data: { running } });
    }

    /** Stamp a seq, remember for replay, fan out to every subscriber. */
    private broadcast(sessionId: string, ctx: ActiveSession, part: { type: string; data: unknown }): void {
        const seq = ++ctx.seq;
        ctx.ring.push({ seq, part });
        if (ctx.ring.length > EVENT_RING_SIZE) ctx.ring.shift();
        for (const sub of ctx.subscribers) {
            sub.send({
                jsonrpc: "2.0",
                method: "session.event",
                params: { sessionId, seq, part },
            });
        }
    }

    private wireCtx(sessionId: string, ctx: ActiveSession): void {
        // Forward the ENTIRE turn stream — reasoning, tool lifecycle, subagents,
        // step usage, recap — not a hand-picked subset. TURN_EVENT_NAMES is the
        // single source of truth: a new event on the agent loop reaches clients
        // automatically (and can't be forgotten — the list is build-checked).
        for (const event of TURN_EVENT_NAMES) {
            // Only the two that can carry an Error pay for the rewrite — the
            // other twenty-two include every text/reasoning/input delta, and
            // copying those per token would be a cost with no payoff.
            const carriesError = ERROR_BEARING_EVENTS.has(event);
            ctx.emitter.on(event, (data: unknown) => {
                this.broadcast(sessionId, ctx, { type: event, data: carriesError ? plainError(data) : data });
            });
        }
    }
}

/**
 * What a remote client may attach, and the extension each is written as.
 *
 * PDFs belong here for the same reason the images do: `extractImagesFromInput`
 * and its `[image:…]` sentinel have always accepted `.pdf` — a PDF dropped on
 * the TUI is an attachment like any other — and `runTurn` already decides
 * whether the chosen model may actually receive it
 * (`filterAttachmentsByModalities`: modality "pdf" AND a provider that takes
 * inline PDF bytes). Leaving pdf out here was the only thing stopping a GUI
 * client from attaching one; it was not a policy, and the policy that does
 * exist lives one layer down where it can see the model.
 */
const ATTACHMENT_EXT_BY_TYPE: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "application/pdf": "pdf",
};
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Persist base64 attachment payloads (images, PDFs) to temp files; returns
 * "[image:…]" sentinels to append to the input (empty string when there is
 * nothing valid). Exported for tests. */
export function writeAttachmentPayloads(raw: unknown): string {
    if (!Array.isArray(raw) || raw.length === 0) return "";
    let out = "";
    for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
        const attachment = item as { data?: unknown; mediaType?: unknown };
        const ext = ATTACHMENT_EXT_BY_TYPE[String(attachment.mediaType ?? "")];
        if (!ext || typeof attachment.data !== "string") continue;
        const bytes = Buffer.from(attachment.data, "base64");
        if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
        const path = join(tmpdir(), `${PRODUCT_NAME}-attach-${randomBytes(8).toString("hex")}.${ext}`);
        writeFileSync(path, bytes);
        out += `\n[image:${path}]`;
    }
    return out;
}

export function startStdioServer(): void {
    const server = new RpcServer();
    const transport: Transport = {
        send(msg) {
            process.stdout.write(JSON.stringify(msg) + "\n");
        },
    };
    const { feed } = server.attach(transport);
    // Three ways this process ends, and all of them have to reap what bash
    // started. The desktop's LoopProcess.stop() is a plain kill(), so SIGTERM
    // is the common path, not the exotic one.
    let leaving = false;
    const leave = () => {
        if (leaving) return;
        leaving = true;
        server.dispose();
        process.exit(0);
    };
    process.stdin.on("data", feed);
    process.stdin.on("end", leave);
    process.on("SIGTERM", leave);
    process.on("SIGINT", leave);
}

function rpcPaths(): { socketPath: string; pidPath: string } {
    const dir = join(getConfigDir(), "agent");
    mkdirSync(dir, { recursive: true });
    return { socketPath: join(dir, "rpc.sock"), pidPath: join(dir, "rpc.pid") };
}

/** Pid from rpc.pid if that process is still alive, else null (stale/absent). */
function liveDaemonPid(pidPath: string): number | null {
    if (!existsSync(pidPath)) return null;
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        process.kill(pid, 0); // signal 0 = existence check only
        return pid;
    } catch {
        return null;
    }
}

export function startSocketServer(): { server: Server; socketPath: string; pidPath: string } {
    const { socketPath, pidPath } = rpcPaths();
    const alive = liveDaemonPid(pidPath);
    if (alive)
        throw new Error(
            `${PRODUCT_NAME} rpc daemon already running (pid ${alive}); stop it with: ${PRODUCT_NAME} rpc stop`,
        );
    // Any leftover socket belongs to a dead daemon (the pid check above).
    if (existsSync(socketPath)) unlinkSync(socketPath);

    const server = new RpcServer();
    const net = createServer((socket: Socket) => {
        const transport: Transport = {
            send(msg) {
                socket.write(JSON.stringify(msg) + "\n");
            },
        };
        const { feed, close } = server.attach(transport);
        socket.on("data", feed);
        socket.on("close", close);
        socket.on("error", () => socket.destroy());
    });

    net.listen(socketPath, () => {
        writeFileSync(pidPath, String(process.pid));
    });

    // Leave no stale socket/pid behind on a signal exit — the next start would
    // otherwise have to clean up after us.
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // Before the socket goes: a client cannot reconnect to kill a shell
        // whose registry died with this process.
        server.dispose();
        try {
            unlinkSync(socketPath);
        } catch {}
        try {
            unlinkSync(pidPath);
        } catch {}
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return { server: net, socketPath, pidPath };
}

/**
 * Stop a running socket daemon via its pid file (SIGTERM — the daemon's own
 * handler cleans up its socket/pid). Returns what happened for the CLI to
 * report; stale files from a dead daemon are cleaned up here.
 */
export function stopSocketServer(): { stopped: boolean; pid?: number } {
    const { socketPath, pidPath } = rpcPaths();
    const pid = liveDaemonPid(pidPath);
    if (!pid) {
        try {
            unlinkSync(socketPath);
        } catch {}
        try {
            unlinkSync(pidPath);
        } catch {}
        return { stopped: false };
    }
    process.kill(pid, "SIGTERM");
    return { stopped: true, pid };
}
