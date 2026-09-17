/**
 * Connects to a single MCP server and returns its tools, namespaced so they
 * never collide with loop's built-ins or another server's tools.
 */
import { brandEnv } from "../brand";
import { createHash } from "node:crypto";
import { createMCPClient, ElicitationRequestSchema, UnauthorizedError } from "@ai-sdk/mcp";
import {
    isHttpServer,
    isToolAllowed,
    type HttpServerConfig,
    type McpServerConfig,
    type ToolAccessPolicy,
} from "./config";
import { buildTransport } from "./transport";
import { hasStoredTokens, oauthClientOptions, McpOAuthProvider } from "./oauth";
import { interceptNotifications, type McpNotificationHandler } from "./notifications";
import { handleElicitation } from "./elicitation";

export type McpClient = Awaited<ReturnType<typeof createMCPClient>>;
export type McpToolSet = Record<string, unknown>;

/**
 * Everything a live connection reports back to the manager. Passed as one
 * object because a connection now has more than one thing to say and the
 * positional-callback version was already at its limit.
 */
export interface ConnectHandlers {
    /** The connection died — stdio child exited, socket dropped, transport errored. */
    onDisconnect?: (err: unknown) => void;
    /** The server sent a JSON-RPC notification (tool list changed, log line, progress). */
    onNotification?: McpNotificationHandler;
}

export interface ConnectResult {
    client: McpClient;
    tools: McpToolSet;
    /** Number of tools the server exposed (after namespacing). */
    toolCount: number;
}

/** Tool/server name charset the AI SDK accepts in a tool key. */
const UNSAFE_NAME_CHARS = /[^a-zA-Z0-9_]/g;

function sanitize(name: string): string {
    return name.replace(UNSAFE_NAME_CHARS, "_");
}

/**
 * Providers cap a tool name at 64 characters (Anthropic's schema is
 * `^[a-zA-Z0-9_-]{1,64}$`, and OpenAI's is the same length). A long server name
 * plus a long tool name goes past that easily, and the provider rejects the
 * WHOLE request — so one verbose MCP server breaks every turn, not just its own
 * tool. Names are shortened from the middle of the tool half, keeping the
 * server prefix (which is how the model and our own routing find it) and enough
 * of the tool's head and tail to stay readable.
 */
const MAX_TOOL_NAME = 64;

/**
 * Characters a tool is guaranteed to get, and therefore the longest server
 * segment a prefix may carry.
 *
 * Without a floor here, a server named long enough ate the entire budget and
 * the shortener fell back to slicing the tail off the combined name — which
 * threw the `mcp__<server>__` prefix away. Everything that finds a server's
 * tools works by that prefix: withdrawing them when the connection drops,
 * attributing them in `/mcp`, keeping two servers from overwriting each other.
 * So those tools became unremovable and unattributable, and a dead server's
 * tools stayed in every later turn's tool set. Capping the server segment keeps
 * the prefix intact for every possible name; two servers that collide once
 * capped are caught by the manager's prefix-clash check, same as before.
 */
const MIN_TOOL_CHARS = 8;
const MAX_SERVER_CHARS = MAX_TOOL_NAME - MIN_TOOL_CHARS - "mcp____".length;

function fitToolName(prefix: string, tool: string): string {
    const full = `${prefix}${tool}`;
    if (full.length <= MAX_TOOL_NAME) return full;
    // At least MIN_TOOL_CHARS by construction — see serverPrefix.
    const budget = MAX_TOOL_NAME - prefix.length;
    const head = Math.ceil((budget - 1) / 2);
    const tail = budget - 1 - head;
    return `${prefix}${tool.slice(0, head)}_${tool.slice(tool.length - tail)}`;
}

/** Shared prefix for every tool from one server: `mcp__<server>__`. */
export function serverPrefix(server: string): string {
    return `mcp__${sanitize(server).slice(0, MAX_SERVER_CHARS)}__`;
}

/** `mcp__<server>__<tool>` — the Claude Code convention, capped at 64 chars. */
export function namespacedToolName(server: string, tool: string): string {
    return fitToolName(serverPrefix(server), sanitize(tool));
}

/**
 * The key one tool is filed under, guaranteed not to be one already taken.
 *
 * `namespacedToolName` is not injective, in two ways that both occur in the
 * wild. Sanitizing folds the charset, so a server exposing `get-issue` and
 * `get_issue` maps both to the same key. Shortening keeps only a long name's
 * head and tail, so two names differing only in the middle — which is what a
 * verbose server's names look like — also land on the same key.
 *
 * These were being written into a plain object, so the second silently replaced
 * the first: the tool count under-reported the server, one tool became
 * unreachable, and the model was handed a name whose schema and behaviour
 * belonged to a different tool. Disambiguating with a digest of the real name
 * keeps every tool addressable and keeps the key stable across reconnects.
 */
function uniqueToolName(server: string, tool: string, taken: Set<string>): string {
    const base = namespacedToolName(server, tool);
    if (!taken.has(base)) return base;
    const tag = createHash("sha1").update(tool).digest("hex").slice(0, 4);
    for (let attempt = 0; ; attempt++) {
        const suffix = attempt === 0 ? `_${tag}` : `_${tag}${attempt}`;
        // base already starts with the prefix and the prefix is capped well
        // short of this cut, so the server prefix always survives.
        const candidate = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/**
 * Hard ceiling on a single MCP tool call. A wedged stdio child or a dropped
 * HTTP connection can leave `callTool` pending forever — the agent loop then
 * awaits a result that never arrives and the whole UI appears frozen. Racing
 * each call against a timeout turns that hang into a normal tool error the
 * model can recover from. Overridable via LOOP_MCP_TOOL_TIMEOUT_MS.
 */
const MCP_TOOL_TIMEOUT_MS = Number(brandEnv("MCP_TOOL_TIMEOUT_MS")) || 120_000;

type ExecutableTool = { execute?: (input: unknown, options: unknown) => Promise<unknown> };

interface McpCallResult {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
}

function isMcpCallResult(value: unknown): value is McpCallResult {
    return typeof value === "object" && value !== null && ("content" in value || "structuredContent" in value);
}

/**
 * Preserve a tool's `structuredContent`. The AI SDK MCP client only maps a
 * result's `content` blocks into the model-facing output when the tool is
 * created with an explicit outputSchema; with the automatic schemas we use
 * (client.tools() with no args), `structuredContent` is dropped entirely. A
 * server that returns its real payload there with an empty `content` array
 * (e.g. codespec) then hands the model — and our persistence — nothing.
 *
 * So when a result carries structuredContent but no text block, surface it as a
 * text block. Generic: any structured-output MCP server benefits, no per-server
 * code. Servers that already return text content are left untouched.
 */
function preserveStructuredContent(result: unknown): unknown {
    if (!isMcpCallResult(result)) return result;
    if (result.structuredContent == null) return result;
    const content = Array.isArray(result.content) ? result.content : [];
    const hasText = content.some((part) => part?.type === "text" && part.text);
    if (hasText) return result;
    const asText = { type: "text", text: JSON.stringify(result.structuredContent, null, 2) };
    return { ...result, content: [...content, asText] };
}

/**
 * A rejection that means the connection is gone rather than the call failing.
 * The AI SDK reports both a transport that closed under a pending request
 * ("Connection closed") and a call made after that ("closed client") this way.
 */
const CLOSED_CONNECTION = /connection closed|closed client|transport closed|not connected/i;

/**
 * A protocol message the SDK declined to handle, rather than a broken
 * connection.
 *
 * The SDK answers a server->client request it does not implement
 * (`sampling/createMessage`, `roots/list`) with a JSON-RPC "method not found"
 * AND reports it through `onUncaughtError` — and any message it cannot classify
 * at all becomes "Unsupported message type". Neither says anything about the
 * health of the connection, but both used to tear it down: the server stayed
 * connected and working while loop marked it errored and withdrew its tools.
 *
 * Notifications are intercepted before the SDK can produce that error at all
 * (see ./notifications), so this is the belt to that braces — it also covers a
 * transport we could not hook, and the sampling/roots requests we genuinely do
 * not serve yet.
 */
const BENIGN_PROTOCOL_ERROR = /unsupported message type|unsupported request method|no elicitation handler/i;

export function isBenignProtocolError(err: unknown): boolean {
    return BENIGN_PROTOCOL_ERROR.test(err instanceof Error ? err.message : String(err));
}

export function isDisconnectError(err: unknown): boolean {
    return CLOSED_CONNECTION.test(err instanceof Error ? err.message : String(err));
}

/**
 * Wrap a tool's execute so a call that never settles rejects instead of
 * hanging, so structuredContent-only results aren't silently lost, and so a
 * connection that died is reported to the manager instead of being rediscovered
 * by every later call.
 *
 * The timeout also ABORTS the underlying request rather than just walking away
 * from it: the SDK forwards `options.abortSignal` down to callTool, so a timed
 * out call stops occupying the server (and, for stdio, stops holding a response
 * handler open forever) the moment we give up on it.
 */
function withTimeout(name: string, tool: ExecutableTool, onDisconnect?: (err: unknown) => void): ExecutableTool {
    if (typeof tool.execute !== "function") return tool;
    const original = tool.execute.bind(tool);
    return {
        ...tool,
        execute: (input: unknown, options: unknown) => {
            const abort = new AbortController();
            const caller = (options ?? {}) as { abortSignal?: AbortSignal };
            const onCallerAbort = () => abort.abort(caller.abortSignal?.reason);
            caller.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
            let timer: ReturnType<typeof setTimeout>;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    abort.abort();
                    reject(new Error(`MCP tool ${name} timed out after ${MCP_TOOL_TIMEOUT_MS}ms`));
                }, MCP_TOOL_TIMEOUT_MS);
            });
            const call = original(input, { ...caller, abortSignal: abort.signal });
            return Promise.race([call, timeout])
                .then(preserveStructuredContent)
                .catch((err: unknown) => {
                    if (isDisconnectError(err)) onDisconnect?.(err);
                    throw err;
                })
                .finally(() => {
                    clearTimeout(timer);
                    caller.abortSignal?.removeEventListener("abort", onCallerAbort);
                });
        },
    };
}

/**
 * List a live server's tools, namespaced and wrapped, ready to merge into the
 * agent's tool set.
 *
 * Shared by the initial connect and by the `tools/list_changed` refresh: a
 * server that adds, removes or renames a tool mid-session (which is the entire
 * point of the capability it advertises) must end up with exactly the same
 * naming, timeout and disconnect wrapping it got at connect time. Two code
 * paths building that set separately is how the refreshed one quietly loses the
 * timeout wrapper.
 */
export async function fetchTools(
    server: string,
    client: McpClient,
    onDisconnect?: (err: unknown) => void,
    policy?: ToolAccessPolicy,
): Promise<McpToolSet> {
    const raw = (await client.tools()) as McpToolSet;
    // Filtered on the SERVER'S OWN names, before namespacing: a policy is
    // written against the names the server documents, not against loop's
    // `mcp__<server>__` keys (which are shortened when long, so matching them
    // would silently stop working on exactly the verbose servers a policy is
    // most likely to be written for).
    const permitted = policy
        ? Object.fromEntries(Object.entries(raw).filter(([name]) => isToolAllowed(policy, name)))
        : raw;
    return namespaceTools(server, permitted, onDisconnect);
}

function namespaceTools(server: string, tools: McpToolSet, onDisconnect?: (err: unknown) => void): McpToolSet {
    const namespaced: McpToolSet = {};
    const taken = new Set<string>();
    for (const [toolName, tool] of Object.entries(tools)) {
        const key = uniqueToolName(server, toolName, taken);
        taken.add(key);
        namespaced[key] = withTimeout(key, tool as ExecutableTool, onDisconnect);
    }
    return namespaced;
}

/**
 * Throws on connection failure — the manager catches per-server so one bad
 * server never takes down the rest. OAuth servers get a token-backed provider
 * (no browser opener) so the transport can refresh silently; if no tokens are
 * stored yet the provider throws McpAuthRequiredError, which the manager maps
 * to needs-auth. A remote server that turns out to speak the other HTTP
 * transport is retried once on that one rather than reported as unreachable.
 */
export async function connectServer(
    name: string,
    cfg: McpServerConfig,
    handlers: ConnectHandlers = {},
): Promise<ConnectResult> {
    try {
        return await connectOnce(name, cfg, handlers);
    } catch (err) {
        const fallback = otherTransport(cfg, err);
        if (!fallback) throw err;
        return await connectOnce(name, fallback, handlers);
    }
}

/**
 * The same server over the transport it actually speaks, or undefined when
 * that isn't the problem.
 *
 * Streamable HTTP and SSE share a URL shape and nothing in it says which one a
 * server implements, so "http" vs "sse" is a guess the user makes when they add
 * the entry — and getting it wrong looks like the server being down. Figma's
 * local Dev Mode server is the common case: it has served SSE for most of its
 * life while every example anyone copies says `--transport http`. The SDK
 * already recognises the mismatch (it says so in the error text), so take it at
 * its word and retry rather than reporting a dead server.
 *
 * A 401 is excluded deliberately: an auth failure means the transport is right
 * and the credentials are not, and retrying it would replace an actionable
 * "sign in" with a confusing transport error.
 */
function otherTransport(cfg: McpServerConfig, err: unknown): HttpServerConfig | undefined {
    if (!isHttpServer(cfg)) return undefined;
    if (isUnauthorizedError(err)) return undefined;
    if (!isWrongTransportError(err)) return undefined;
    return { ...cfg, type: cfg.type === "http" ? "sse" : "http" };
}

/** The SDK's own "you picked the wrong one" signal, plus the statuses that carry it. */
const WRONG_TRANSPORT = /does not support (?:HTTP|SSE) transport|try using `(?:sse|http)` transport/i;

function isWrongTransportError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    if (WRONG_TRANSPORT.test(message)) return true;
    // Not every server is polite enough to trigger the SDK's hint: one that only
    // speaks SSE typically answers a streamable-HTTP POST with 405 (or 404 for
    // the endpoint that isn't there), with no explanation at all.
    const status = statusCodeOf(err);
    return status === 404 || status === 405;
}

function statusCodeOf(err: unknown): number | undefined {
    const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
    return typeof status === "number" ? status : undefined;
}

/**
 * The server refused us for lack of credentials, rather than failing.
 *
 * The SDK only raises a typed `UnauthorizedError` when a transport was given an
 * auth provider to recover with. A remote server added as a plain URL has
 * none — so its 401 arrives as a generic transport error whose message is
 * `POSTing to endpoint (HTTP 401)`, and a user who has simply not signed in yet
 * is told their server is broken. Recognising it by status too is what lets the
 * manager offer the one action that helps.
 */
export function isUnauthorizedError(err: unknown): boolean {
    if (err instanceof UnauthorizedError) return true;
    if (statusCodeOf(err) === 401) return true;
    return err instanceof Error && /\bHTTP 401\b|\bunauthorized\b/i.test(err.message);
}

async function connectOnce(
    name: string,
    cfg: McpServerConfig,
    handlers: ConnectHandlers = {},
): Promise<ConnectResult> {
    const { onDisconnect, onNotification } = handlers;
    // A stored session is reason enough to attach the provider: `auth: "oauth"`
    // is a flag people rarely set (a server usually reveals it wants OAuth by
    // answering 401), and without the provider a server the user has already
    // signed in to would connect anonymously and be refused — with its tokens
    // sitting unused on disk.
    const authProvider =
        isHttpServer(cfg) && (cfg.auth === "oauth" || hasStoredTokens(name))
            ? new McpOAuthProvider(name, oauthRefreshRedirectUri(), undefined, oauthClientOptions(cfg))
            : undefined;
    const transport = watchTransport(buildTransport(cfg, authProvider), onDisconnect);
    // Before construction, so a server that announces itself the instant the
    // handshake completes can't slip a notification past us (stdio only — an
    // HTTP transport is built inside the SDK and is hooked below instead).
    if (onNotification) interceptNotifications(transport, onNotification);
    const client = await createMCPClient({
        name: `loop-mcp-${name}`,
        transport,
        // Declared so servers know they may ask. The SDK only forwards
        // `elicitation/create` to a registered handler — without the handler
        // below it answers "no elicitation handler registered on client", which
        // is a tool call that can never complete on a server built around a
        // mid-call confirmation.
        capabilities: { elicitation: {} },
        // Async transport errors must not crash the process. They also mean this
        // connection is finished, which is the manager's business — its status
        // is what the /mcp panel and the next turn's tool set are built from.
        onUncaughtError: (err) => {
            if (isBenignProtocolError(err)) return;
            onDisconnect?.(err);
        },
    });
    // The HTTP/SSE transports are constructed inside createMCPClient, so this
    // is the first moment they can be reached. Idempotent with the hook above.
    if (onNotification) interceptNotifications((client as { transport?: unknown }).transport, onNotification);
    // Answered by whatever UI is attached, or declined outright when there is
    // none — never left pending, which would stall the server's tool call until
    // its timeout.
    client.onElicitationRequest(ElicitationRequestSchema, (request) => handleElicitation(name, request.params));
    let rawTools: McpToolSet;
    try {
        rawTools = (await fetchTools(name, client, onDisconnect, cfg)) as McpToolSet;
    } catch (err) {
        // The handshake succeeded, so there is a live subprocess (or socket)
        // behind this client even though the connect as a whole failed. Nobody
        // else has a handle on it: without this the child outlives the process
        // that spawned it, and every retry orphans another one.
        await client.close().catch(() => {});
        throw err;
    }
    return { client, tools: rawTools, toolCount: Object.keys(rawTools).length };
}

/**
 * Learn when the connection dies.
 *
 * The SDK routes transport ERRORS to `onUncaughtError`, but a clean close — an
 * stdio child that exits, a socket the server hangs up — only reaches
 * `transport.onclose`, which the SDK claims for itself the moment the client is
 * constructed. So for a transport instance we own (stdio), the property is
 * re-defined to chain: the SDK's handler still runs, and ours runs after it.
 * HTTP transports are built inside the SDK from a config object and cannot be
 * hooked this way — they surface a dead connection through onUncaughtError, or
 * on the next call (see withTimeout).
 */
function watchTransport<T>(transport: T, onDisconnect?: (err: unknown) => void): T {
    if (!onDisconnect || typeof transport !== "object" || transport === null) return transport;
    let handler: (() => void) | undefined;
    try {
        Object.defineProperty(transport, "onclose", {
            configurable: true,
            get: () => handler,
            set: (fn: (() => void) | undefined) => {
                handler = () => {
                    fn?.();
                    onDisconnect(new Error("connection closed"));
                };
            },
        });
    } catch {
        // A sealed transport is not a reason to fail the connect; the call-time
        // path still catches the dead connection.
    }
    return transport;
}

/**
 * Redirect URI used only for token refresh on background connects. Matches the
 * callback server's preferred port so a server that allow-lists the URI accepts
 * it; refresh itself never sends the redirect, so the exact port rarely matters.
 */
function oauthRefreshRedirectUri(): string {
    const port = Number(brandEnv("MCP_OAUTH_CALLBACK_PORT")) || 8976;
    return `http://127.0.0.1:${port}/callback`;
}
