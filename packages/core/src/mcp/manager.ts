/**
 * Long-lived MCP connections. Clients hold subprocesses/sockets, so they are
 * created once at startup (not per turn) and reused across the session. The
 * agent loop reads aggregated tools via the module singleton; the /mcp panel
 * reads status snapshots and drives authorize/enable/remove.
 */
import { brandEnv } from "../brand";
import { UnauthorizedError } from "@ai-sdk/mcp";
import {
    connectServer,
    fetchTools,
    isBenignProtocolError,
    isUnauthorizedError,
    serverPrefix,
    type McpClient,
    type McpToolSet,
} from "./client";
import { debugLog } from "../debug";
import type { McpNotification } from "./notifications";
import {
    EMPTY_CATALOG,
    fetchCatalog,
    fetchPrompts,
    fetchResources,
    fetchResourceTemplates,
    flattenResourceContents,
    readCapabilities,
    renderPromptMessages,
    type McpCapabilities,
    type McpFeatureCatalog,
    type McpPromptEntry,
    type McpResourceEntry,
    type McpResourceTemplateEntry,
    type ReadResourcePart,
} from "./features";
import {
    addServer,
    isHttpServer,
    isServerEnabled,
    loadConnectableServers,
    loadMcpServers,
    removeServer,
    setServerEnabled,
    type McpServerConfig,
} from "./config";
import { isTrusted } from "../agent/trust";
import { authorizeServer } from "./authorize";
import { clearMcpAuth, McpAuthRequiredError } from "./oauth";

export type ServerStatus = "disabled" | "connecting" | "ready" | "error" | "needs-auth";

/**
 * Hard ceiling on a single server's connect (spawn + handshake + tools/list). A
 * stdio child that wedges on startup, or an HTTP server that accepts the socket
 * but never replies, would otherwise leave `connectServer` pending forever —
 * the status stays "connecting" and, in print mode (which awaits init), the
 * whole run hangs. Racing against a timeout turns that into a normal `error`
 * status the user can see and retry. Overridable via LOOP_MCP_CONNECT_TIMEOUT_MS.
 */
const CONNECT_TIMEOUT_MS = Number(brandEnv("MCP_CONNECT_TIMEOUT_MS")) || 30_000;

/**
 * A rejecting timer plus a `clear()` so a fast connect doesn't leave the
 * 30s timer pinning the event loop open (which would hang a CLI exit or a test
 * run). Caller clears it in a `finally`.
 */
/**
 * How often a connected server is probed, and how long a probe may take.
 *
 * A dead stdio child announces itself: the transport closes and we hear about
 * it. A remote server does not — an HTTP connection can be silently gone for an
 * hour while loop still advertises its tools and every call the model makes
 * fails. The probe is a `tools/list`, which is the one request every MCP server
 * implements, and it doubles as a refresh for servers that change their tools
 * without sending list_changed. Set LOOP_MCP_HEALTH_INTERVAL_MS=0 to turn it off.
 */
function envMs(suffix: string, fallback: number): number {
    const raw = brandEnv(suffix);
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read when the timer is armed, not at import, so it is settable per process. */
const healthIntervalMs = () => envMs("MCP_HEALTH_INTERVAL_MS", 60_000);

/**
 * Ceiling on one probe.
 *
 * Without it the probe inherits the failure it is meant to detect: a server
 * that accepts the connection and never answers leaves `listTools()` pending
 * forever, so the one request whose job is to notice a wedged server is itself
 * wedged, and every later probe stacks another pending promise behind it.
 */
const probeTimeoutMs = () => envMs("MCP_PROBE_TIMEOUT_MS", 10_000);

/**
 * Reconnect backoff after a server drops. Doubling from 1s, capped, and given
 * up on after a handful of tries — a server that is gone for good must not have
 * loop respawning its process every second for the rest of the session.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;

function connectTimeout(name: string): { promise: Promise<never>; clear: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`connection to "${name}" timed out after ${CONNECT_TIMEOUT_MS}ms`)),
            CONNECT_TIMEOUT_MS,
        );
    });
    return { promise, clear: () => clearTimeout(timer) };
}

export interface ServerState {
    name: string;
    status: ServerStatus;
    toolCount: number;
    error?: string;
    config: McpServerConfig;
    client?: McpClient;
    /** What the server declared in its handshake; absent until connected. */
    capabilities?: McpCapabilities;
    /** Resources, templates and prompts — everything that isn't a tool. */
    catalog?: McpFeatureCatalog;
    /**
     * The server's own usage notes from the initialize result. The SDK has
     * always exposed these and loop always dropped them, so a server's
     * instructions for its own tools never reached the model.
     */
    instructions?: string;
}

/** Status snapshot for the /mcp panel — no live client handle leaked. */
export type ServerSnapshot = Omit<ServerState, "client">;

export class McpManager {
    private servers = new Map<string, ServerState>();
    private tools: McpToolSet = {};
    private initialized = false;
    private cwd = process.cwd();
    /**
     * Bumped for a server every time something new is asked of it. A connect
     * carries the generation it started under and refuses to write its result
     * if that number has moved — otherwise a connect still in flight when the
     * user hits delete lands afterwards and puts the server back, tools and
     * all, with a live client nobody will ever close.
     */
    private generations = new Map<string, number>();
    /** Servers with a tools/list refresh in flight, and ones that asked again while it ran. */
    private refreshing = new Set<string>();
    private refreshPending = new Set<string>();
    /** Pending reconnect timers, and how many attempts each server has spent. */
    private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private reconnectAttempts = new Map<string, number>();
    private healthTimer?: ReturnType<typeof setInterval>;

    /** Connect every enabled server in parallel. Safe to call once per session. */
    async init(cwd: string): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        this.cwd = cwd;
        const configs = loadConnectableServers(cwd, isTrusted(cwd));
        await Promise.allSettled(Object.entries(configs).map(([name, cfg]) => this.connectOne(name, cfg)));
        this.startHealthChecks();
    }

    /**
     * Probe connected servers on a timer.
     *
     * `unref` matters as much as the interval does: a repeating timer that
     * keeps the event loop alive turns a finished `loop run` into a process
     * that never exits. The probe is skipped entirely when the interval is 0.
     */
    private startHealthChecks(): void {
        const interval = healthIntervalMs();
        if (this.healthTimer || interval <= 0) return;
        this.healthTimer = setInterval(() => void this.checkHealth(), interval);
        (this.healthTimer as { unref?: () => void }).unref?.();
    }

    /**
     * Probe every connected server once. Public so the panel can offer a
     * check-now, and so the behaviour is testable without waiting on a timer.
     *
     * Probes run in parallel and each is bounded: one unresponsive server must
     * not delay the verdict on the others.
     */
    async checkHealth(): Promise<void> {
        const timeout = probeTimeoutMs();
        await Promise.all(
            [...this.servers.values()].map(async (server) => {
                if (server.status !== "ready" || !server.client) return;
                const generation = this.generations.get(server.name);
                if (generation === undefined) return;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        server.client.listTools(),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(
                                () => reject(new Error(`health probe timed out after ${timeout}ms`)),
                                timeout,
                            );
                        }),
                    ]);
                } catch (err) {
                    // The connection is gone without the transport ever saying
                    // so — how a remote server usually fails. Treated exactly
                    // like a dropped one, reconnect and all.
                    this.markDisconnected(server.name, generation, err);
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }),
        );
    }

    /**
     * Bring a dropped server back on its own.
     *
     * Before this, a server that died mid-session stayed dead until someone
     * noticed and ran `/mcp reconnect` — and the way people noticed was the
     * model failing to call its tools. Only servers that were WORKING are
     * retried: a config error or a missing login will fail identically forever,
     * and retrying those is just noise with a subprocess attached.
     */
    private scheduleReconnect(name: string): void {
        if (this.reconnectTimers.has(name)) return;
        const attempt = this.reconnectAttempts.get(name) ?? 0;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        this.reconnectAttempts.set(name, attempt + 1);
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(name);
            const server = this.servers.get(name);
            // Anything that changed the server's state in the meantime — a
            // manual reconnect, a disable, a delete — wins over this.
            if (!server || server.status !== "error") return;
            void this.connectOne(name, server.config).then(() => {
                if (this.servers.get(name)?.status === "ready") {
                    this.reconnectAttempts.delete(name);
                    return;
                }
                this.scheduleReconnect(name);
            });
        }, delay);
        (timer as { unref?: () => void }).unref?.();
        this.reconnectTimers.set(name, timer);
    }

    /** Stop any pending reconnect for a server the user has taken charge of. */
    private cancelReconnect(name: string): void {
        const timer = this.reconnectTimers.get(name);
        if (timer) clearTimeout(timer);
        this.reconnectTimers.delete(name);
        this.reconnectAttempts.delete(name);
    }

    /** Claim the next generation for a server; the caller's connect owns it. */
    private nextGeneration(name: string): number {
        const next = (this.generations.get(name) ?? 0) + 1;
        this.generations.set(name, next);
        return next;
    }

    /** Invalidate whatever is in flight for a server (delete, disable, reconnect). */
    private supersede(name: string): void {
        this.nextGeneration(name);
        // Whatever the user just did outranks a retry we scheduled.
        this.cancelReconnect(name);
    }

    private async connectOne(name: string, cfg: McpServerConfig): Promise<void> {
        const generation = this.nextGeneration(name);
        const current = () => this.generations.get(name) === generation;
        if (!isServerEnabled(cfg)) {
            this.servers.set(name, { name, status: "disabled", toolCount: 0, config: cfg });
            return;
        }
        // Two servers whose names differ only in characters the tool-name
        // charset can't carry ("my-fs" and "my.fs") share a prefix, so the
        // second one's tools would silently overwrite the first's and removing
        // either would drop both. Say so instead.
        const clash = this.prefixClash(name);
        if (clash) {
            this.servers.set(name, {
                name,
                status: "error",
                toolCount: 0,
                config: cfg,
                error: `tool prefix ${serverPrefix(name)} collides with server "${clash}" — rename one of them`,
            });
            return;
        }
        this.servers.set(name, { name, status: "connecting", toolCount: 0, config: cfg });
        const connecting = connectServer(name, cfg, {
            onDisconnect: (err) => this.markDisconnected(name, generation, err),
            onNotification: (notification) => this.handleNotification(name, generation, notification),
        });
        const timeout = connectTimeout(name);
        try {
            const { client, tools, toolCount } = await Promise.race([connecting, timeout.promise]);
            if (!current()) {
                // Removed, disabled or reconnected while we were connecting:
                // this result belongs to nobody. Close it rather than leaking it.
                await client.close().catch(() => {});
                return;
            }
            // Tool keys are already namespaced with this server's prefix by
            // connectServer, so a plain merge can't clobber another server.
            Object.assign(this.tools, tools);
            const capabilities = readCapabilities(client);
            const instructions = (client as { instructions?: string }).instructions;
            this.servers.set(name, {
                name,
                status: "ready",
                toolCount,
                config: cfg,
                client,
                capabilities,
                catalog: EMPTY_CATALOG,
                ...(instructions ? { instructions } : {}),
            });
            // Resources and prompts are fetched after the server is marked
            // ready, not before: they are extras, and making the connect wait
            // on them would put a slow catalog between the user and their
            // tools. They arrive a beat later and the panel updates.
            void this.loadCatalog(name, generation);
            this.reconnectAttempts.delete(name);
        } catch (err) {
            if (current()) this.setFailed(name, cfg, err);
            // If the timer won the race, the connect may still resolve later with
            // a live subprocess/socket — close it so the timeout doesn't leak it.
            void connecting.then(({ client }) => client.close()).catch(() => {});
        } finally {
            timeout.clear();
        }
    }

    /**
     * Another server that would namespace its tools identically. Counts one
     * that is still connecting, not just a connected one: `init` connects every
     * server at once, so at check time the twin usually hasn't finished yet.
     */
    private prefixClash(name: string): string | undefined {
        const prefix = serverPrefix(name);
        for (const other of this.servers.values()) {
            if (other.name === name) continue;
            if (other.status !== "ready" && other.status !== "connecting") continue;
            if (serverPrefix(other.name) === prefix) return other.name;
        }
        return undefined;
    }

    /**
     * The connection died on its own — the stdio child exited, the socket
     * dropped, the transport errored. Without this the server sat at "ready"
     * forever while its tools stayed in every subsequent turn's tool set, so
     * the model kept calling things that could only fail. Marked error and its
     * tools withdrawn; `/mcp reconnect` brings it back.
     */
    private markDisconnected(name: string, generation: number, err: unknown): void {
        if (this.generations.get(name) !== generation) return;
        // A message the SDK refused to handle is not a dead connection. See
        // isBenignProtocolError — this used to drop a perfectly healthy server.
        if (isBenignProtocolError(err)) {
            debugLog("mcp", `${name}: ignoring protocol notice:`, err);
            return;
        }
        const server = this.servers.get(name);
        if (!server || server.status !== "ready") return;
        this.dropTools(name);
        this.servers.set(name, {
            ...server,
            status: "error",
            toolCount: 0,
            client: undefined,
            catalog: EMPTY_CATALOG,
            error: `disconnected: ${describe(err)}`,
        });
        void server.client?.close().catch(() => {});
        // A server that was working a moment ago is worth getting back on its
        // own — see scheduleReconnect for why only that case is retried.
        this.scheduleReconnect(name);
    }

    /**
     * A notification from a server. None of these are errors, and none of them
     * may end the connection — before this existed, every one of them did (the
     * SDK reports an unhandled notification through `onUncaughtError`, which
     * loop read as a disconnect).
     *
     * `tools/list_changed` is the one with real work behind it: a server that
     * advertises the capability expects the client to re-list, and a client
     * that doesn't goes on calling tools that no longer exist while never
     * seeing the ones that now do. The rest are recorded and dropped —
     * resource and prompt caches don't exist yet, and progress/logging have no
     * surface to reach.
     */
    private handleNotification(name: string, generation: number, notification: McpNotification): void {
        if (this.generations.get(name) !== generation) return;
        switch (notification.method) {
            case "notifications/tools/list_changed":
                void this.refreshTools(name, generation);
                return;
            case "notifications/resources/list_changed":
                void this.loadCatalog(name, generation, "resources");
                return;
            case "notifications/prompts/list_changed":
                void this.loadCatalog(name, generation, "prompts");
                return;
            case "notifications/resources/updated":
                // Nothing is cached for a single resource — reads always go to
                // the server — so this only matters to whoever is watching.
                this.emitResourceUpdated(name, notification);
                return;
            case "notifications/message":
                debugLog("mcp", `${name}: server log:`, notification.params);
                return;
            default:
                debugLog("mcp", `${name}: notification ${notification.method}`);
        }
    }

    /**
     * Re-list one server's tools into the live tool set.
     *
     * Coalesced per server: a server that rebuilds its tool list emits a burst
     * of list_changed (one per registration is common), and each one would
     * otherwise be its own tools/list round trip. While a refresh is running,
     * later notifications set a flag that runs exactly one more afterwards, so
     * the final state always reflects the last notification.
     *
     * The swap is drop-then-merge rather than a merge alone: a tool the server
     * REMOVED has to disappear from the agent's tool set, and merging can only
     * ever add.
     */
    private async refreshTools(name: string, generation: number): Promise<void> {
        if (this.refreshing.has(name)) {
            this.refreshPending.add(name);
            return;
        }
        this.refreshing.add(name);
        try {
            const server = this.servers.get(name);
            if (!server?.client || server.status !== "ready") return;
            const tools = await fetchTools(
                name,
                server.client,
                (err) => this.markDisconnected(name, generation, err),
                server.config,
            );
            // Re-read: the connection can have died, or been superseded, during
            // the round trip. Writing tools back for a server that is gone is
            // exactly the leak the generation guard exists to prevent.
            if (this.generations.get(name) !== generation) return;
            if (this.servers.get(name)?.status !== "ready") return;
            this.dropTools(name);
            Object.assign(this.tools, tools);
            this.servers.set(name, { ...server, toolCount: Object.keys(tools).length });
        } catch (err) {
            // A failed re-list leaves the previous tools in place: they were
            // working a moment ago, and withdrawing them over one bad round
            // trip is worse than serving a list that may be one edit stale.
            debugLog("mcp", `${name}: tools refresh failed:`, err);
        } finally {
            this.refreshing.delete(name);
            if (this.refreshPending.delete(name)) void this.refreshTools(name, generation);
        }
    }

    /**
     * Load (or reload) one server's resources and prompts.
     *
     * `section` narrows the reload to the half a notification was about — a
     * server announcing new prompts has no reason to make us re-walk a
     * thousand resources. Everything is capability-gated inside fetchCatalog,
     * so a tools-only server does no work here at all.
     */
    private async loadCatalog(name: string, generation: number, section?: "resources" | "prompts"): Promise<void> {
        const server = this.servers.get(name);
        if (!server?.client || server.status !== "ready" || !server.capabilities) return;
        const capabilities = server.capabilities;
        const client = server.client;
        try {
            let catalog: McpFeatureCatalog;
            if (section === "resources" && capabilities.resources) {
                const [resources, resourceTemplates] = await Promise.all([
                    fetchResources(name, client),
                    fetchResourceTemplates(name, client),
                ]);
                catalog = { ...(server.catalog ?? EMPTY_CATALOG), resources, resourceTemplates };
            } else if (section === "prompts" && capabilities.prompts) {
                catalog = { ...(server.catalog ?? EMPTY_CATALOG), prompts: await fetchPrompts(name, client) };
            } else if (section) {
                return; // Announced a capability it never declared; nothing to do.
            } else {
                catalog = await fetchCatalog(name, client, capabilities);
            }
            // The connection can die, or be superseded, during the round trip.
            if (this.generations.get(name) !== generation) return;
            const current = this.servers.get(name);
            if (!current || current.status !== "ready") return;
            this.servers.set(name, { ...current, catalog });
            if (catalog.prompts.length || section === "prompts") this.onPromptsChanged?.();
        } catch (err) {
            debugLog("mcp", `${name}: catalog load failed:`, err);
        }
    }

    /**
     * Called when a server's prompt list changes, so the host can re-register
     * the slash commands built from it. Set by whoever owns the command
     * registry; absent in print mode and subagents, where there are none.
     */
    onPromptsChanged?: () => void;

    /** Called when a subscribed resource changes server-side. */
    onResourceUpdated?: (server: string, uri: string) => void;

    private emitResourceUpdated(name: string, notification: McpNotification): void {
        const uri = notification.params?.uri;
        if (typeof uri !== "string") return;
        debugLog("mcp", `${name}: resource updated ${uri}`);
        this.onResourceUpdated?.(name, uri);
    }

    /** Every resource on every connected server, server-qualified. */
    listResources(): McpResourceEntry[] {
        return this.catalogEntries((catalog) => catalog.resources);
    }

    listResourceTemplates(): McpResourceTemplateEntry[] {
        return this.catalogEntries((catalog) => catalog.resourceTemplates);
    }

    listPrompts(): McpPromptEntry[] {
        return this.catalogEntries((catalog) => catalog.prompts);
    }

    private catalogEntries<T>(pick: (catalog: McpFeatureCatalog) => T[]): T[] {
        const out: T[] = [];
        for (const server of this.servers.values()) {
            if (server.status !== "ready" || !server.catalog) continue;
            out.push(...pick(server.catalog));
        }
        return out;
    }

    /** A connected server's client, or a readable error naming what went wrong. */
    private liveClient(name: string): McpClient {
        const server = this.servers.get(name);
        if (!server) throw new Error(`unknown MCP server: ${name}`);
        if (server.status !== "ready" || !server.client) {
            throw new Error(`MCP server "${name}" is ${server.status}${server.error ? `: ${server.error}` : ""}`);
        }
        return server.client;
    }

    /**
     * Read one resource. Not cached: `resources/updated` exists precisely
     * because contents change, and a stale read served from memory is worse
     * than a round trip.
     */
    async readResource(name: string, uri: string): Promise<ReadResourcePart[]> {
        const result = await this.liveClient(name).readResource({ uri });
        return flattenResourceContents(result.contents);
    }

    /** Subscribe to a resource, when the server said it supports subscriptions. */
    supportsResourceSubscribe(name: string): boolean {
        return Boolean(this.servers.get(name)?.capabilities?.resourceSubscribe);
    }

    /** Fetch a prompt and render its messages into a single submittable block. */
    async getPrompt(name: string, prompt: string, args: Record<string, string>): Promise<string> {
        const result = await this.liveClient(name).experimental_getPrompt({ name: prompt, arguments: args });
        return renderPromptMessages(result.messages);
    }

    /**
     * Argument completion for a prompt or resource template. Servers that
     * never declared the capability are not asked — and an empty list, not a
     * throw, is what a completion UI wants from a server that can't help.
     */
    async completeArgument(
        name: string,
        ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string },
        argument: { name: string; value: string },
    ): Promise<string[]> {
        const server = this.servers.get(name);
        if (!server?.capabilities?.completions) return [];
        try {
            const result = await this.liveClient(name).complete({ ref, argument });
            return result.completion.values;
        } catch (err) {
            debugLog("mcp", `${name}: completion/complete failed:`, err);
            return [];
        }
    }

    /**
     * OAuth servers that aren't logged in get a distinct, actionable status.
     *
     * A bare 401 counts. A remote server added as a plain URL has no auth
     * provider for the SDK to recover with, so its refusal arrives as an
     * ordinary transport error reading `POSTing to endpoint (HTTP 401)` — which
     * used to park it at "error", where the web panel offers reconnect and
     * nothing else, and reconnecting an unauthenticated server forever is not a
     * plan. Only for HTTP servers: a stdio child has no login to offer, so
     * "unauthorized" in its output means something else entirely.
     */
    private setFailed(name: string, cfg: McpServerConfig, err: unknown): void {
        const needsAuth =
            err instanceof McpAuthRequiredError ||
            err instanceof UnauthorizedError ||
            (isHttpServer(cfg) && isUnauthorizedError(err));
        this.servers.set(name, {
            name,
            status: needsAuth ? "needs-auth" : "error",
            toolCount: 0,
            config: cfg,
            error: needsAuth ? undefined : describe(err),
        });
    }

    /** Aggregated, namespaced tool set for the agent loop. Empty until init. */
    getTools(): McpToolSet {
        return this.tools;
    }

    listServers(): ServerSnapshot[] {
        return [...this.servers.values()].map(({ client: _client, ...rest }) => rest);
    }

    getServer(name: string): ServerSnapshot | undefined {
        const s = this.servers.get(name);
        if (!s) return undefined;
        const { client: _client, ...rest } = s;
        return rest;
    }

    hasServers(): boolean {
        return this.servers.size > 0;
    }

    /** Persist a new global server, then connect it. Used by the /mcp add flow. */
    async add(name: string, cfg: McpServerConfig): Promise<void> {
        addServer(name, cfg);
        const existing = this.servers.get(name);
        if (existing) await this.closeOne(existing);
        await this.connectOne(name, cfg);
    }

    /**
     * Connect a server whose config is already persisted elsewhere.
     *
     * `add` writes to the GLOBAL settings file, so it cannot serve a
     * project-scoped server (`.loop/mcp.json`) — and `reconnect` only walks
     * servers this process already knows, which a just-written one is not.
     * Without this a project server stayed invisible until the next launch.
     */
    async adopt(name: string, cfg: McpServerConfig): Promise<void> {
        const existing = this.servers.get(name);
        if (existing) {
            // Supersede BEFORE closing. `closeOne` trips the transport's
            // onclose, which is the same signal an unexpected drop gives, so a
            // deliberate replacement briefly flashed the server as "error"
            // (and, once auto-anything keys off that, would do more than flash).
            this.supersede(name);
            await this.closeOne(existing);
        }
        await this.connectOne(name, cfg);
    }

    /**
     * Follow the session into another directory.
     *
     * The manager captured `cwd` at `init()` and never let go, so after a `/cd`
     * everything project-scoped was still read from the folder loop launched
     * in: `reconnect` re-read that folder's `.loop/mcp.json`, evaluated that
     * folder's trust, and the servers belonging to the folder the user actually
     * moved to never connected at all. User-scope servers are untouched here —
     * they don't belong to any directory, and tearing down a working connection
     * on a `cd` would be its own bug.
     */
    async setCwd(cwd: string): Promise<void> {
        if (cwd === this.cwd) return;
        this.cwd = cwd;
        if (!this.initialized) return;
        const allowed = loadConnectableServers(cwd, isTrusted(cwd));
        // Servers that belonged to the folder we left.
        for (const server of [...this.servers.values()]) {
            if (server.name in allowed) continue;
            this.supersede(server.name);
            await this.closeOne(server);
            this.servers.delete(server.name);
        }
        // Servers this folder brings, or brings under a different definition.
        for (const [name, cfg] of Object.entries(allowed)) {
            if (sameConfig(this.servers.get(name)?.config, cfg)) continue;
            await this.adopt(name, cfg);
        }
    }

    /** Forget a server this process connected, without touching any config. */
    async forget(name: string): Promise<boolean> {
        this.supersede(name);
        const existing = this.servers.get(name);
        if (!existing) return false;
        await this.closeOne(existing);
        this.servers.delete(name);
        return true;
    }

    /**
     * Reconnect one server (or all), from the config as it is on disk RIGHT
     * NOW. Used by /mcp reconnect.
     *
     * It used to reconnect from the config in memory, which made it useless for
     * the thing people actually reach for it after: editing settings.json or
     * .loop/mcp.json to fix a server. A corrected command reconnected with the
     * old one, and a newly added server never appeared at all — `init()` is a
     * no-op after the first call, so nothing re-read the file. Now the file is
     * the source of truth again: added servers connect, edited ones use their
     * new config, and ones deleted from disk are dropped.
     */
    async reconnect(name?: string): Promise<void> {
        const onDisk = loadConnectableServers(this.cwd, isTrusted(this.cwd));
        if (name) {
            const cfg = onDisk[name] ?? this.servers.get(name)?.config;
            if (!cfg) {
                await this.forget(name);
                return;
            }
            const existing = this.servers.get(name);
            if (existing) {
                this.supersede(name);
                await this.closeOne(existing);
            }
            await this.connectOne(name, cfg);
            return;
        }
        for (const server of [...this.servers.values()]) {
            await this.closeOne(server);
            // Deleted from the file since we loaded it — reconnect means "match
            // the config", so it goes rather than lingering as a ghost row.
            if (!(server.name in onDisk)) {
                this.supersede(server.name);
                this.servers.delete(server.name);
            }
        }
        await Promise.allSettled(Object.entries(onDisk).map(([n, cfg]) => this.connectOne(n, cfg)));
    }

    /** Run the browser OAuth login for a server, then connect it. */
    async authorize(name: string, openUrl: (url: string) => void, cfg?: McpServerConfig): Promise<void> {
        const server = this.servers.get(name);
        // A caller holding the config can sign in to a server this process has
        // never connected — a settings page lists from disk without connecting
        // (that costs up to 30s per server), and "reconnect before you can sign
        // in" is a step nobody should have to know about.
        const config = server?.config ?? cfg;
        if (!config) throw new Error(`unknown MCP server: ${name}`);
        await authorizeServer(name, config, openUrl);
        if (server) await this.closeOne(server);
        await this.connectOne(name, config);
    }

    /** Toggle a global server on/off, persisting the choice and (dis)connecting. */
    async setEnabled(name: string, enabled: boolean): Promise<boolean> {
        const server = this.servers.get(name);
        if (!server) return false;
        if (!setServerEnabled(name, enabled)) return false;
        const cfg: McpServerConfig = { ...server.config, enabled };
        this.supersede(name);
        await this.closeOne(server);
        if (enabled) {
            await this.connectOne(name, cfg);
        } else {
            this.servers.set(name, { name, status: "disabled", toolCount: 0, config: cfg });
        }
        return true;
    }

    /** Delete a global server: disconnect, forget its OAuth session, drop config. */
    async remove(name: string): Promise<boolean> {
        // Before anything else: a connect still in flight for this name must not
        // be allowed to write itself back in once it lands.
        this.supersede(name);
        const server = this.servers.get(name);
        if (server) await this.closeOne(server);
        clearMcpAuth(name);
        this.servers.delete(name);
        return removeServer(name);
    }

    async close(): Promise<void> {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = undefined;
        for (const name of this.servers.keys()) this.supersede(name);
        for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
        this.reconnectTimers.clear();
        this.reconnectAttempts.clear();
        await Promise.allSettled([...this.servers.values()].map((s) => this.closeOne(s)));
        this.tools = {};
        this.servers.clear();
        this.initialized = false;
    }

    private async closeOne(server: ServerState): Promise<void> {
        try {
            await server.client?.close();
        } catch {
            // Best-effort teardown — a wedged transport shouldn't block exit.
        }
        this.dropTools(server.name);
    }

    private dropTools(name: string): void {
        const prefix = serverPrefix(name);
        for (const key of Object.keys(this.tools)) {
            if (key.startsWith(prefix)) delete this.tools[key];
        }
    }
}

/**
 * Whether a server's definition has actually changed. Both sides come from the
 * same JSON files, so key order is stable and a string compare is enough; a
 * false "changed" only costs one needless reconnect.
 */
function sameConfig(a: McpServerConfig | undefined, b: McpServerConfig): boolean {
    return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** An error as a line a user can read. */
function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

let singleton: McpManager | undefined;

export function getMcpManager(): McpManager {
    if (!singleton) singleton = new McpManager();
    return singleton;
}
