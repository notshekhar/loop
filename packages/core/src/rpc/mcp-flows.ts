/**
 * Managing MCP servers from a remote client.
 *
 * Everything the TUI's `/mcp` panel does — list with live status, add, remove,
 * enable/disable, reconnect, and the OAuth browser login — over the RPC, so a
 * GUI has the same reach as the terminal. Core already owns all of it
 * (`src/mcp`); this is the transport-shaped edge, nothing more.
 *
 * The login is the only part that is not a plain request/response. It hands
 * back a URL to open and finishes minutes later, which a JSON-RPC call cannot
 * hold open — so it takes the same shape as provider login
 * (`auth.flow.start`/`poll`/`cancel` in ./auth-flows): a small server-side
 * object with an append-only event log the client drains by cursor. Polling
 * rather than pushing, for the same reason: loop's notification channel is
 * per-session and authorizing a server belongs to no session.
 */
import { randomBytes } from "node:crypto";
import {
    getGlobalServers,
    getMcpManager,
    serverPrefix,
    getProjectServers,
    hasStoredTokens,
    isGlobalServer,
    isHttpServer,
    isMcpEnabled,
    isOAuthServer,
    isServerEnabled,
    loadMcpServers,
    McpUnsupportedServerError,
    projectServersPath,
    unsupportedRemoteServer,
    type McpServerConfig,
    type ServerStatus,
} from "../mcp";

/** Where a server's definition lives, which decides what may be done to it. */
export type McpScope = "global" | "project";

export interface McpServerDescriptor {
    readonly name: string;
    readonly scope: McpScope;
    readonly transport: "stdio" | "http" | "sse";
    /** Live status when this process has connected; the configured state otherwise. */
    readonly status: ServerStatus;
    readonly enabled: boolean;
    readonly toolCount: number;
    readonly error?: string;
    /** stdio only: what gets spawned, already joined for display. */
    readonly command?: string;
    /** http/sse only. */
    readonly url?: string;
    /**
     * True when signing in applies to this server — it is configured for OAuth,
     * has asked for auth, or has been signed into before. A client shows its
     * authorize action on this, not on `status`: a live session can expire
     * while the status still reads "ready", and that is exactly when someone
     * needs the button.
     */
    readonly oauth: boolean;
    /** OAuth servers only: whether tokens are on disk right now. */
    readonly authorized?: boolean;
    /** Names of the tools it contributes, when connected. */
    readonly tools?: readonly string[];
}

export interface McpListResult {
    /** The master `mcp` setting. Every server is inert when this is false. */
    readonly enabled: boolean;
    readonly servers: readonly McpServerDescriptor[];
    /** Where a project-scoped server would be written for this cwd. */
    readonly projectConfigPath: string;
    /**
     * Whether this process has actually connected yet. Status is configuration
     * only until it has, and a UI should say so rather than claim "ready".
     */
    readonly connected: boolean;
}

function transportOf(config: McpServerConfig): "stdio" | "http" | "sse" {
    return isHttpServer(config) ? config.type : "stdio";
}

function commandOf(config: McpServerConfig): string | undefined {
    if (isHttpServer(config)) return undefined;
    return [config.command, ...(config.args ?? [])].join(" ");
}

/**
 * Every configured server, merged with whatever the manager knows.
 *
 * Deliberately does NOT call `init()`. Connecting is up to 30s per server, and
 * a settings page that hangs half a minute before drawing anything is worse
 * than one that draws immediately and says "not connected" — the client asks
 * for `mcp.reconnect` when it wants the live picture.
 */
export function listMcpServers(cwd: string): McpListResult {
    const manager = getMcpManager();
    const live = new Map(manager.listServers().map((snapshot) => [snapshot.name, snapshot]));
    const globals = getGlobalServers();
    const projectServers = getProjectServers(cwd);
    const configured = loadMcpServers(cwd);
    const toolNames = Object.keys(manager.getTools());

    const servers = Object.entries(configured).map(([name, config]): McpServerDescriptor => {
        const snapshot = live.get(name);
        const enabled = isServerEnabled(config);
        const oauth = isOAuthServer(name, config, snapshot?.status === "needs-auth");
        // The namespaced prefix, not the raw name: tool keys are built by
        // serverPrefix(), which sanitizes the name into the tool-name charset.
        // Matching on the raw name showed NO tools for any server whose name
        // had a dash or a dot in it, and `includes` let a server whose name is
        // a suffix of another's ("fs" vs "myfs") claim the other's tools.
        const prefix = serverPrefix(name);
        const tools = toolNames.filter((tool) => tool.startsWith(prefix));
        return {
            name,
            // Project wins on a name collision — loadMcpServers() resolves it
            // that way, so the row must describe the entry actually in force,
            // not the shadowed global one a client would then try to edit.
            scope: name in projectServers ? "project" : name in globals && isGlobalServer(name) ? "global" : "project",
            transport: transportOf(config),
            status: snapshot?.status ?? (enabled ? "connecting" : "disabled"),
            enabled,
            toolCount: snapshot?.toolCount ?? 0,
            ...(snapshot?.error ? { error: snapshot.error } : {}),
            ...(commandOf(config) ? { command: commandOf(config) } : {}),
            ...(isHttpServer(config) ? { url: config.url } : {}),
            oauth,
            ...(oauth ? { authorized: hasStoredTokens(name) } : {}),
            ...(tools.length > 0 ? { tools } : {}),
        };
    });

    return {
        enabled: isMcpEnabled(),
        servers,
        projectConfigPath: projectServersPath(cwd),
        connected: live.size > 0,
    };
}

/**
 * `headers` / `env` must be flat string maps: they are handed to the transport
 * and run through ${env:VAR} substitution, which is string work. A nested
 * object used to be written to settings.json unchallenged and then failed at
 * connect time with "value.replace is not a function", which says nothing
 * about the config that caused it.
 */
function stringMap(value: unknown, field: string): Record<string, string> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry !== "string") throw new Error(`${field}.${key} must be a string`);
        out[key] = entry;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a config off the wire.
 *
 * A client can send anything, and a bad entry is written to settings.json
 * before anything tries to connect — so a silently accepted `{}` becomes a
 * permanent broken row the GUI then has to explain.
 */
export function parseServerConfig(input: unknown): McpServerConfig {
    if (typeof input !== "object" || input === null) throw new Error("server config required");
    const raw = input as Record<string, unknown>;
    const type = typeof raw.type === "string" ? raw.type : "stdio";
    const enabled = raw.enabled === false ? { enabled: false } : {};

    if (type === "http" || type === "sse") {
        const url = String(raw.url ?? "").trim();
        if (!url) throw new Error("an http/sse server needs a url");
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`not a valid url: ${url}`);
        }
        // The CLI has always required http(s) here; this path did not, so a
        // GUI could write `file://` or `ws://` into settings.json and get a
        // permanent row that fails at connect time with a transport error
        // instead of the reason.
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(`an http/sse server needs an http:// or https:// url, not ${parsed.protocol}//`);
        }
        // A server that will never issue loop credentials is refused here
        // rather than written down and left to fail at every login.
        const unsupported = unsupportedRemoteServer(url);
        if (unsupported) throw new McpUnsupportedServerError(unsupported);
        const headers = stringMap(raw.headers, "headers");
        const scopes = Array.isArray(raw.scopes) ? raw.scopes.map(String) : undefined;
        return {
            type,
            url,
            ...(raw.auth === "oauth" ? { auth: "oauth" as const } : {}),
            ...(headers ? { headers } : {}),
            ...(typeof raw.clientId === "string" && raw.clientId ? { clientId: raw.clientId } : {}),
            ...(typeof raw.clientSecret === "string" && raw.clientSecret ? { clientSecret: raw.clientSecret } : {}),
            ...(scopes && scopes.length > 0 ? { scopes } : {}),
            ...enabled,
        };
    }

    if (type !== "stdio") throw new Error(`unknown transport: ${type}`);
    const command = String(raw.command ?? "").trim();
    if (!command) throw new Error("a stdio server needs a command");
    const args = Array.isArray(raw.args) ? raw.args.map(String) : undefined;
    const env = stringMap(raw.env, "env");
    return {
        type: "stdio",
        command,
        ...(args && args.length > 0 ? { args } : {}),
        ...(env ? { env } : {}),
        ...enabled,
    };
}

// ─── The OAuth login, as a pollable flow ──────────────────────────────────────

export type McpLoginEvent =
    | { type: "auth"; url: string }
    | { type: "progress"; message: string }
    | { type: "done"; message: string }
    | { type: "error"; message: string };

export type McpLoginStatus = "running" | "done" | "error" | "cancelled";

interface Login {
    readonly id: string;
    readonly server: string;
    readonly events: McpLoginEvent[];
    status: McpLoginStatus;
    finishedAt?: number;
}

const logins = new Map<string, Login>();
/** A finished login is kept briefly so a slow poll still sees how it ended. */
const LOGIN_RETENTION_MS = 60_000;

function sweep(): void {
    const cutoff = Date.now() - LOGIN_RETENTION_MS;
    for (const [id, login] of logins) {
        if (login.finishedAt !== undefined && login.finishedAt < cutoff) logins.delete(id);
    }
}

function finish(login: Login, status: McpLoginStatus, event: McpLoginEvent): void {
    if (login.status !== "running") return;
    login.status = status;
    login.finishedAt = Date.now();
    login.events.push(event);
}

export function startMcpLogin(name: string, cwd = process.cwd()): { flowId: string; server: string } {
    sweep();
    const server = name.trim();
    if (!server) throw new Error("server name required");
    // Configured is enough: `mcp.list` deliberately does not connect, so on a
    // freshly-opened settings page the manager knows nothing yet — and being
    // told to reconnect before signing in is a step that only exists because
    // of how this happens to be wired.
    const config = getMcpManager().getServer(server)?.config ?? loadMcpServers(cwd)[server];
    if (!config) {
        throw new Error(`unknown MCP server: ${server} (check the name)`);
    }

    // A second login for the same server would race the first over the same
    // callback port and the same token file.
    for (const existing of logins.values()) {
        if (existing.server === server && existing.status === "running") {
            return { flowId: existing.id, server };
        }
    }

    const login: Login = {
        id: randomBytes(8).toString("hex"),
        server,
        events: [{ type: "progress", message: `Authorizing ${server}…` }],
        status: "running",
    };
    logins.set(login.id, login);

    void getMcpManager()
        .authorize(server, (url) => login.events.push({ type: "auth", url }), config)
        .then(() => {
            const snapshot = getMcpManager().getServer(server);
            finish(login, "done", {
                type: "done",
                message: `${server} authorized — ${snapshot?.toolCount ?? 0} tools.`,
            });
        })
        .catch((err: unknown) => {
            finish(login, "error", {
                type: "error",
                message: err instanceof Error ? err.message : String(err),
            });
        });

    return { flowId: login.id, server };
}

export interface PollMcpLoginResult {
    readonly status: McpLoginStatus;
    readonly cursor: number;
    readonly events: readonly McpLoginEvent[];
}

export function pollMcpLogin(flowId: string, cursor = 0): PollMcpLoginResult {
    const login = logins.get(flowId);
    if (!login) throw new Error(`unknown MCP login: ${flowId}`);
    const from = Math.max(0, Math.min(cursor, login.events.length));
    return { status: login.status, cursor: login.events.length, events: login.events.slice(from) };
}

/**
 * Give up on a login.
 *
 * The browser half cannot be recalled — `authorizeServer` owns its own callback
 * server and timeout — so this marks the flow finished for the client rather
 * than pretending to abort it. Whatever the browser does afterwards lands in a
 * flow nobody is reading.
 */
export function cancelMcpLogin(flowId: string): { ok: true } {
    const login = logins.get(flowId);
    if (login) finish(login, "cancelled", { type: "error", message: "Authorization cancelled." });
    return { ok: true };
}

/** Test seam: drop every login so state cannot leak between cases. */
export function resetMcpLogins(): void {
    logins.clear();
}

