/**
 * Long-lived MCP connections. Clients hold subprocesses/sockets, so they are
 * created once at startup (not per turn) and reused across the session. The
 * agent loop reads aggregated tools via the module singleton; the /mcp panel
 * reads status snapshots and drives authorize/enable/remove.
 *
 * The parts live in `manager/`: the shared server table, one server's
 * connection lifecycle, recovery (health probe + reconnect backoff), live
 * updates from server notifications, and the non-tool features. This class
 * wires them together and owns the user-driven operations.
 */
import type { McpToolSet } from "./client";
import { addServer, loadConnectableServers, removeServer, setServerEnabled, type McpServerConfig } from "./config";
import type { McpPromptEntry, McpResourceEntry, McpResourceTemplateEntry, ReadResourcePart } from "./features";
import { isTrusted } from "../agent/trust";
import { authorizeServer } from "./authorize";
import { clearMcpAuth } from "./oauth";
import { ServerConnector } from "./manager/connection";
import { LiveUpdates } from "./manager/live-updates";
import { HealthMonitor, ReconnectScheduler } from "./manager/recovery";
import { ServerFeatures, type CompletionRef } from "./manager/server-features";
import { ServerTable, type ServerSnapshot } from "./manager/state";

export type { ServerSnapshot, ServerState, ServerStatus } from "./manager/state";

export class McpManager {
    private readonly table = new ServerTable();
    private initialized = false;
    private cwd = process.cwd();

    private readonly reconnects = new ReconnectScheduler({
        table: this.table,
        connect: (name, cfg) => this.connector.connectOne(name, cfg),
    });
    private readonly updates = new LiveUpdates({
        table: this.table,
        markDisconnected: (name, generation, err) => this.connector.markDisconnected(name, generation, err),
        promptsChanged: () => this.onPromptsChanged?.(),
        resourceUpdated: (server, uri) => this.onResourceUpdated?.(server, uri),
    });
    private readonly connector = new ServerConnector({
        table: this.table,
        loadCatalog: (name, generation) => this.updates.loadCatalog(name, generation),
        handleNotification: (name, generation, notification) =>
            this.updates.handleNotification(name, generation, notification),
        scheduleReconnect: (name) => this.reconnects.schedule(name),
        resetReconnectAttempts: (name) => this.reconnects.resetAttempts(name),
    });
    private readonly health = new HealthMonitor({
        table: this.table,
        markDisconnected: (name, generation, err) => this.connector.markDisconnected(name, generation, err),
    });
    private readonly features = new ServerFeatures(this.table);

    /**
     * Called when a server's prompt list changes, so the host can re-register
     * the slash commands built from it. Set by whoever owns the command
     * registry; absent in print mode and subagents, where there are none.
     */
    onPromptsChanged?: () => void;

    /** Called when a subscribed resource changes server-side. */
    onResourceUpdated?: (server: string, uri: string) => void;

    /** Connect every enabled server in parallel. Safe to call once per session. */
    async init(cwd: string): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        this.cwd = cwd;
        const configs = loadConnectableServers(cwd, isTrusted(cwd));
        await Promise.allSettled(Object.entries(configs).map(([name, cfg]) => this.connector.connectOne(name, cfg)));
        this.health.start();
    }

    /**
     * Probe every connected server once. Public so the panel can offer a
     * check-now, and so the behaviour is testable without waiting on a timer.
     */
    async checkHealth(): Promise<void> {
        await this.health.checkAll();
    }

    /** Invalidate whatever is in flight for a server (delete, disable, reconnect). */
    private supersede(name: string): void {
        this.table.nextGeneration(name);
        // Whatever the user just did outranks a retry we scheduled.
        this.reconnects.cancel(name);
    }

    /** Every resource on every connected server, server-qualified. */
    listResources(): McpResourceEntry[] {
        return this.features.listResources();
    }

    listResourceTemplates(): McpResourceTemplateEntry[] {
        return this.features.listResourceTemplates();
    }

    listPrompts(): McpPromptEntry[] {
        return this.features.listPrompts();
    }

    /** Read one resource, uncached (see ServerFeatures.readResource). */
    readResource(name: string, uri: string): Promise<ReadResourcePart[]> {
        return this.features.readResource(name, uri);
    }

    /** Subscribe to a resource, when the server said it supports subscriptions. */
    supportsResourceSubscribe(name: string): boolean {
        return this.features.supportsResourceSubscribe(name);
    }

    /** Fetch a prompt and render its messages into a single submittable block. */
    getPrompt(name: string, prompt: string, args: Record<string, string>): Promise<string> {
        return this.features.getPrompt(name, prompt, args);
    }

    /** Argument completion for a prompt or resource template; [] when the server can't help. */
    completeArgument(name: string, ref: CompletionRef, argument: { name: string; value: string }): Promise<string[]> {
        return this.features.completeArgument(name, ref, argument);
    }

    /** Aggregated, namespaced tool set for the agent loop. Empty until init. */
    getTools(): McpToolSet {
        return this.table.tools;
    }

    listServers(): ServerSnapshot[] {
        return [...this.table.servers.values()].map(({ client: _client, ...rest }) => rest);
    }

    getServer(name: string): ServerSnapshot | undefined {
        const s = this.table.servers.get(name);
        if (!s) return undefined;
        const { client: _client, ...rest } = s;
        return rest;
    }

    hasServers(): boolean {
        return this.table.servers.size > 0;
    }

    /** Persist a new global server, then connect it. Used by the /mcp add flow. */
    async add(name: string, cfg: McpServerConfig): Promise<void> {
        addServer(name, cfg);
        const existing = this.table.servers.get(name);
        if (existing) await this.connector.closeOne(existing);
        await this.connector.connectOne(name, cfg);
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
        await this.replace(name, cfg);
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
        for (const server of [...this.table.servers.values()]) {
            if (server.name in allowed) continue;
            this.supersede(server.name);
            await this.connector.closeOne(server);
            this.table.servers.delete(server.name);
        }
        // Servers this folder brings, or brings under a different definition.
        for (const [name, cfg] of Object.entries(allowed)) {
            if (sameConfig(this.table.servers.get(name)?.config, cfg)) continue;
            await this.adopt(name, cfg);
        }
    }

    /** Forget a server this process connected, without touching any config. */
    async forget(name: string): Promise<boolean> {
        this.supersede(name);
        const existing = this.table.servers.get(name);
        if (!existing) return false;
        await this.connector.closeOne(existing);
        this.table.servers.delete(name);
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
            const cfg = onDisk[name] ?? this.table.servers.get(name)?.config;
            if (!cfg) {
                await this.forget(name);
                return;
            }
            await this.replace(name, cfg);
            return;
        }
        for (const server of [...this.table.servers.values()]) {
            await this.connector.closeOne(server);
            // Deleted from the file since we loaded it — reconnect means "match
            // the config", so it goes rather than lingering as a ghost row.
            if (!(server.name in onDisk)) {
                this.supersede(server.name);
                this.table.servers.delete(server.name);
            }
        }
        await Promise.allSettled(Object.entries(onDisk).map(([n, cfg]) => this.connector.connectOne(n, cfg)));
    }

    /** Supersede and close any live connection for `name`, then connect it from `cfg`. */
    private async replace(name: string, cfg: McpServerConfig): Promise<void> {
        const existing = this.table.servers.get(name);
        if (existing) {
            // Supersede BEFORE closing. `closeOne` trips the transport's
            // onclose, which is the same signal an unexpected drop gives, so a
            // deliberate replacement briefly flashed the server as "error"
            // (and, once auto-anything keys off that, would do more than flash).
            this.supersede(name);
            await this.connector.closeOne(existing);
        }
        await this.connector.connectOne(name, cfg);
    }

    /** Run the browser OAuth login for a server, then connect it. */
    async authorize(name: string, openUrl: (url: string) => void, cfg?: McpServerConfig): Promise<void> {
        const server = this.table.servers.get(name);
        // A caller holding the config can sign in to a server this process has
        // never connected — a settings page lists from disk without connecting
        // (that costs up to 30s per server), and "reconnect before you can sign
        // in" is a step nobody should have to know about.
        const config = server?.config ?? cfg;
        if (!config) throw new Error(`unknown MCP server: ${name}`);
        await authorizeServer(name, config, openUrl);
        if (server) await this.connector.closeOne(server);
        await this.connector.connectOne(name, config);
    }

    /** Toggle a global server on/off, persisting the choice and (dis)connecting. */
    async setEnabled(name: string, enabled: boolean): Promise<boolean> {
        const server = this.table.servers.get(name);
        if (!server) return false;
        if (!setServerEnabled(name, enabled)) return false;
        const cfg: McpServerConfig = { ...server.config, enabled };
        this.supersede(name);
        await this.connector.closeOne(server);
        if (enabled) {
            await this.connector.connectOne(name, cfg);
        } else {
            this.table.servers.set(name, { name, status: "disabled", toolCount: 0, config: cfg });
        }
        return true;
    }

    /** Delete a global server: disconnect, forget its OAuth session, drop config. */
    async remove(name: string): Promise<boolean> {
        // Before anything else: a connect still in flight for this name must not
        // be allowed to write itself back in once it lands.
        this.supersede(name);
        const server = this.table.servers.get(name);
        if (server) await this.connector.closeOne(server);
        clearMcpAuth(name);
        this.table.servers.delete(name);
        return removeServer(name);
    }

    async close(): Promise<void> {
        this.health.stop();
        for (const name of this.table.servers.keys()) this.supersede(name);
        this.reconnects.cancelAll();
        await Promise.allSettled([...this.table.servers.values()].map((s) => this.connector.closeOne(s)));
        this.table.tools = {};
        this.table.servers.clear();
        this.initialized = false;
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

let singleton: McpManager | undefined;

export function getMcpManager(): McpManager {
    if (!singleton) singleton = new McpManager();
    return singleton;
}
