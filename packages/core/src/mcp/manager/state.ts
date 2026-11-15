/**
 * The manager's shared state: one row per server, the aggregated tool set, and
 * the generation counters that keep a stale connect from writing itself back.
 * Every part of the manager reads and writes through this one table.
 */
import { serverPrefix, type McpClient, type McpToolSet } from "../client";
import type { McpCapabilities, McpFeatureCatalog } from "../features";
import type { McpServerConfig } from "../config";

export type ServerStatus = "disabled" | "connecting" | "ready" | "error" | "needs-auth";

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

export class ServerTable {
    readonly servers = new Map<string, ServerState>();
    /** Replaced wholesale on close, so readers must not cache the object across a close. */
    tools: McpToolSet = {};
    /**
     * Bumped for a server every time something new is asked of it. A connect
     * carries the generation it started under and refuses to write its result
     * if that number has moved — otherwise a connect still in flight when the
     * user hits delete lands afterwards and puts the server back, tools and
     * all, with a live client nobody will ever close.
     */
    private generations = new Map<string, number>();

    /** Claim the next generation for a server; the caller's connect owns it. */
    nextGeneration(name: string): number {
        const next = (this.generations.get(name) ?? 0) + 1;
        this.generations.set(name, next);
        return next;
    }

    generationOf(name: string): number | undefined {
        return this.generations.get(name);
    }

    isCurrent(name: string, generation: number): boolean {
        return this.generations.get(name) === generation;
    }

    /** Withdraw every tool namespaced under this server's prefix. */
    dropTools(name: string): void {
        const prefix = serverPrefix(name);
        for (const key of Object.keys(this.tools)) {
            if (key.startsWith(prefix)) delete this.tools[key];
        }
    }
}
