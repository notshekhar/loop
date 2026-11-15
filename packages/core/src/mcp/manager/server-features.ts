/**
 * Everything a connected server offers besides tools: resources, resource
 * templates, prompts and argument completion — listed from the cached catalog,
 * read and fetched live.
 */
import { debugLog } from "../../debug";
import type { McpClient } from "../client";
import {
    flattenResourceContents,
    renderPromptMessages,
    type McpFeatureCatalog,
    type McpPromptEntry,
    type McpResourceEntry,
    type McpResourceTemplateEntry,
    type ReadResourcePart,
} from "../features";
import type { ServerTable } from "./state";

export type CompletionRef = { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };

export class ServerFeatures {
    constructor(private readonly table: ServerTable) {}

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
        for (const server of this.table.servers.values()) {
            if (server.status !== "ready" || !server.catalog) continue;
            out.push(...pick(server.catalog));
        }
        return out;
    }

    /** A connected server's client, or a readable error naming what went wrong. */
    private liveClient(name: string): McpClient {
        const server = this.table.servers.get(name);
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
        return Boolean(this.table.servers.get(name)?.capabilities?.resourceSubscribe);
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
        ref: CompletionRef,
        argument: { name: string; value: string },
    ): Promise<string[]> {
        const server = this.table.servers.get(name);
        if (!server?.capabilities?.completions) return [];
        try {
            const result = await this.liveClient(name).complete({ ref, argument });
            return result.completion.values;
        } catch (err) {
            debugLog("mcp", `${name}: completion/complete failed:`, err);
            return [];
        }
    }
}
