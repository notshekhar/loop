/**
 * Keeping a connected server's tools, resources and prompts current as the
 * server announces changes — and making sure no notification ends the connection.
 */
import { debugLog } from "../../debug";
import { fetchTools } from "../client";
import {
    EMPTY_CATALOG,
    fetchCatalog,
    fetchPrompts,
    fetchResources,
    fetchResourceTemplates,
    type McpFeatureCatalog,
} from "../features";
import type { McpNotification } from "../notifications";
import type { ServerState, ServerTable } from "./state";

type CatalogSection = "resources" | "prompts";

/** What live updates need from the manager. */
export interface LiveUpdatesHost {
    table: ServerTable;
    markDisconnected(name: string, generation: number, err: unknown): void;
    promptsChanged(): void;
    resourceUpdated(server: string, uri: string): void;
}

export class LiveUpdates {
    /** Servers with a tools/list refresh in flight, and ones that asked again while it ran. */
    private refreshing = new Set<string>();
    private refreshPending = new Set<string>();

    constructor(private readonly host: LiveUpdatesHost) {}

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
    handleNotification(name: string, generation: number, notification: McpNotification): void {
        if (!this.host.table.isCurrent(name, generation)) return;
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
            await this.relistTools(name, generation);
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

    private async relistTools(name: string, generation: number): Promise<void> {
        const { table } = this.host;
        const server = table.servers.get(name);
        if (!server?.client || server.status !== "ready") return;
        const tools = await fetchTools(
            name,
            server.client,
            (err) => this.host.markDisconnected(name, generation, err),
            server.config,
        );
        // Re-read: the connection can have died, or been superseded, during
        // the round trip. Writing tools back for a server that is gone is
        // exactly the leak the generation guard exists to prevent.
        if (!table.isCurrent(name, generation)) return;
        if (table.servers.get(name)?.status !== "ready") return;
        table.dropTools(name);
        Object.assign(table.tools, tools);
        table.servers.set(name, { ...server, toolCount: Object.keys(tools).length });
    }

    /**
     * Load (or reload) one server's resources and prompts.
     *
     * `section` narrows the reload to the half a notification was about — a
     * server announcing new prompts has no reason to make us re-walk a
     * thousand resources. Everything is capability-gated inside fetchCatalog,
     * so a tools-only server does no work here at all.
     */
    async loadCatalog(name: string, generation: number, section?: CatalogSection): Promise<void> {
        const { table } = this.host;
        const server = table.servers.get(name);
        if (!server?.client || server.status !== "ready" || !server.capabilities) return;
        try {
            const catalog = await fetchCatalogSection(server, section);
            if (!catalog) return;
            // The connection can die, or be superseded, during the round trip.
            if (!table.isCurrent(name, generation)) return;
            const current = table.servers.get(name);
            if (!current || current.status !== "ready") return;
            table.servers.set(name, { ...current, catalog });
            if (catalog.prompts.length || section === "prompts") this.host.promptsChanged();
        } catch (err) {
            debugLog("mcp", `${name}: catalog load failed:`, err);
        }
    }

    private emitResourceUpdated(name: string, notification: McpNotification): void {
        const uri = notification.params?.uri;
        if (typeof uri !== "string") return;
        debugLog("mcp", `${name}: resource updated ${uri}`);
        this.host.resourceUpdated(name, uri);
    }
}

/**
 * The catalog after fetching `section` (or everything), or undefined when the
 * server announced a capability it never declared — nothing to do then.
 * Callers guarantee a ready server with a client and capabilities.
 */
async function fetchCatalogSection(
    server: ServerState,
    section: CatalogSection | undefined,
): Promise<McpFeatureCatalog | undefined> {
    const { name } = server;
    const client = server.client!;
    const capabilities = server.capabilities!;
    if (section === "resources" && capabilities.resources) {
        const [resources, resourceTemplates] = await Promise.all([
            fetchResources(name, client),
            fetchResourceTemplates(name, client),
        ]);
        return { ...(server.catalog ?? EMPTY_CATALOG), resources, resourceTemplates };
    }
    if (section === "prompts" && capabilities.prompts) {
        return { ...(server.catalog ?? EMPTY_CATALOG), prompts: await fetchPrompts(name, client) };
    }
    if (section) return undefined;
    return fetchCatalog(name, client, capabilities);
}
