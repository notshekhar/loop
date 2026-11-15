/**
 * One server's connection lifecycle: connect (with a deadline and a
 * generation guard), notice it dropping, record why it failed, and close it.
 */
import { UnauthorizedError } from "@ai-sdk/mcp";
import { debugLog } from "../../debug";
import { connectServer, isBenignProtocolError, isUnauthorizedError, serverPrefix } from "../client";
import { isHttpServer, isServerEnabled, type McpServerConfig } from "../config";
import { EMPTY_CATALOG, readCapabilities } from "../features";
import type { McpNotification } from "../notifications";
import { McpAuthRequiredError } from "../oauth";
import type { ServerState, ServerTable } from "./state";
import { CONNECT_TIMEOUT_MS, rejectAfter } from "./timeouts";

/** What a connection needs from the rest of the manager. */
export interface ConnectionHost {
    table: ServerTable;
    /** Resources and prompts, fetched once the server is ready. */
    loadCatalog(name: string, generation: number): Promise<void>;
    handleNotification(name: string, generation: number, notification: McpNotification): void;
    scheduleReconnect(name: string): void;
    resetReconnectAttempts(name: string): void;
}

type ConnectResult = Awaited<ReturnType<typeof connectServer>>;

export class ServerConnector {
    constructor(private readonly host: ConnectionHost) {}

    async connectOne(name: string, cfg: McpServerConfig): Promise<void> {
        const { table } = this.host;
        const generation = table.nextGeneration(name);
        if (!isServerEnabled(cfg)) {
            table.servers.set(name, { name, status: "disabled", toolCount: 0, config: cfg });
            return;
        }
        // Two servers whose names differ only in characters the tool-name
        // charset can't carry ("my-fs" and "my.fs") share a prefix, so the
        // second one's tools would silently overwrite the first's and removing
        // either would drop both. Say so instead.
        const clash = this.prefixClash(name);
        if (clash) {
            table.servers.set(name, {
                name,
                status: "error",
                toolCount: 0,
                config: cfg,
                error: `tool prefix ${serverPrefix(name)} collides with server "${clash}" — rename one of them`,
            });
            return;
        }
        // The last instructions this server published stay through a reconnect:
        // they ride the system prompt, and dropping them for the seconds a
        // server spends connecting would cost a prompt-cache miss each way.
        table.servers.set(name, {
            name,
            status: "connecting",
            toolCount: 0,
            config: cfg,
            ...this.keptInstructions(name),
        });
        await this.awaitConnect(name, cfg, generation);
    }

    /** Race the connect against its deadline and record whichever way it went. */
    private async awaitConnect(name: string, cfg: McpServerConfig, generation: number): Promise<void> {
        const { table } = this.host;
        const connecting = connectServer(name, cfg, {
            onDisconnect: (err) => this.markDisconnected(name, generation, err),
            onNotification: (notification) => this.host.handleNotification(name, generation, notification),
        });
        const timeout = rejectAfter(
            CONNECT_TIMEOUT_MS,
            `connection to "${name}" timed out after ${CONNECT_TIMEOUT_MS}ms`,
        );
        try {
            const result = await Promise.race([connecting, timeout.promise]);
            if (!table.isCurrent(name, generation)) {
                // Removed, disabled or reconnected while we were connecting:
                // this result belongs to nobody. Close it rather than leaking it.
                await result.client.close().catch(() => {});
                return;
            }
            this.markReady(name, cfg, generation, result);
        } catch (err) {
            if (table.isCurrent(name, generation)) this.setFailed(name, cfg, err);
            // If the timer won the race, the connect may still resolve later with
            // a live subprocess/socket — close it so the timeout doesn't leak it.
            void connecting.then(({ client }) => client.close()).catch(() => {});
        } finally {
            timeout.clear();
        }
    }

    private markReady(name: string, cfg: McpServerConfig, generation: number, result: ConnectResult): void {
        const { table } = this.host;
        const { client, tools, toolCount } = result;
        // Tool keys are already namespaced with this server's prefix by
        // connectServer, so a plain merge can't clobber another server.
        Object.assign(table.tools, tools);
        const capabilities = readCapabilities(client);
        const instructions = (client as { instructions?: string }).instructions;
        table.servers.set(name, {
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
        void this.host.loadCatalog(name, generation);
        this.host.resetReconnectAttempts(name);
    }

    /** The server's last published instructions, as a spreadable fragment. */
    private keptInstructions(name: string): { instructions?: string } {
        const instructions = this.host.table.servers.get(name)?.instructions;
        return instructions ? { instructions } : {};
    }

    /**
     * Another server that would namespace its tools identically. Counts one
     * that is still connecting, not just a connected one: `init` connects every
     * server at once, so at check time the twin usually hasn't finished yet.
     */
    private prefixClash(name: string): string | undefined {
        const prefix = serverPrefix(name);
        for (const other of this.host.table.servers.values()) {
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
    markDisconnected(name: string, generation: number, err: unknown): void {
        const { table } = this.host;
        if (!table.isCurrent(name, generation)) return;
        // A message the SDK refused to handle is not a dead connection. See
        // isBenignProtocolError — this used to drop a perfectly healthy server.
        if (isBenignProtocolError(err)) {
            debugLog("mcp", `${name}: ignoring protocol notice:`, err);
            return;
        }
        const server = table.servers.get(name);
        if (!server || server.status !== "ready") return;
        table.dropTools(name);
        table.servers.set(name, {
            ...server,
            status: "error",
            toolCount: 0,
            client: undefined,
            catalog: EMPTY_CATALOG,
            error: `disconnected: ${describe(err)}`,
        });
        void server.client?.close().catch(() => {});
        // A server that was working a moment ago is worth getting back on its
        // own — see ReconnectScheduler.schedule for why only that case is retried.
        this.host.scheduleReconnect(name);
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
        // Kept for the same reason as on connect: a flapping server must not
        // flip the system prompt.
        this.host.table.servers.set(name, {
            name,
            status: needsAuth ? "needs-auth" : "error",
            toolCount: 0,
            config: cfg,
            error: needsAuth ? undefined : describe(err),
            ...this.keptInstructions(name),
        });
    }

    /** Close a server's client and withdraw its tools. */
    async closeOne(server: ServerState): Promise<void> {
        try {
            await server.client?.close();
        } catch {
            // Best-effort teardown — a wedged transport shouldn't block exit.
        }
        this.host.table.dropTools(server.name);
    }
}

/** An error as a line a user can read. */
function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
