/**
 * `mcp_resource` — the model's way into the resources an MCP server publishes.
 *
 * Tools are the half of MCP loop already had. Resources are the other half:
 * files, records and documents a server offers for reading rather than calling,
 * and until now nothing in loop could see them. They are deliberately NOT
 * exposed as one tool per resource — a server with a few hundred resources
 * would spend the whole tool budget describing them — so this is one tool with
 * a list and a read, the same shape as `shells` and `sql`.
 *
 * Attached only when at least one connected server actually publishes
 * resources, so a tools-only setup never sees it.
 */
import { tool } from "ai";
import { z } from "zod";
import type { McpResourceEntry, McpResourceTemplateEntry, ReadResourcePart } from "../mcp/features";

export const MCP_RESOURCE_TOOL_NAME = "mcp_resource";

export interface McpResourceToolContext {
    listResources: () => McpResourceEntry[];
    listResourceTemplates: () => McpResourceTemplateEntry[];
    readResource: (server: string, uri: string) => Promise<ReadResourcePart[]>;
}

/** Cap on one read, so a resource that turns out to be a 40MB log can't eat the context window. */
const MAX_READ_CHARS = 100_000;

/** Cap on a listing, for the same reason. */
const MAX_LIST_ENTRIES = 200;

function describe(entry: McpResourceEntry): string {
    const label = entry.title ?? entry.name;
    const meta = [entry.mimeType, typeof entry.size === "number" ? `${entry.size}B` : undefined]
        .filter(Boolean)
        .join(", ");
    const suffix = meta ? ` (${meta})` : "";
    const description = entry.description ? ` — ${entry.description}` : "";
    return `${entry.server}:${entry.uri}  ${label}${suffix}${description}`;
}

function describeTemplate(entry: McpResourceTemplateEntry): string {
    const description = entry.description ? ` — ${entry.description}` : "";
    return `${entry.server}:${entry.uriTemplate}  ${entry.title ?? entry.name}${description}`;
}

/** Substring match over everything a user would plausibly search by. */
function matches(entry: McpResourceEntry, query: string): boolean {
    const haystack = `${entry.uri} ${entry.name} ${entry.title ?? ""} ${entry.description ?? ""}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
}

export function createMcpResourceTool(ctx: McpResourceToolContext) {
    return tool({
        description:
            "Read the resources published by connected MCP servers — documents, records and files a server " +
            "offers for reading rather than as a callable tool.\n\n" +
            "- list: every resource, optionally narrowed by `server` and/or a `query` substring. " +
            "Also lists URI TEMPLATES, which describe resources you construct a uri for " +
            "(e.g. `repo://{owner}/{name}/issues`) rather than ones listed individually.\n" +
            "- read: fetch one resource's contents by `server` and `uri`.\n\n" +
            "Prefer `list` first: uris are server-specific and are not guessable. Binary resources are " +
            "described rather than inlined.\n\n" +
            "When the user writes `@mcp:<server>:<uri>` they are pointing at one of these — read it with " +
            "action `read`, `server` and `uri` taken from that token.",
        inputSchema: z.object({
            action: z.enum(["list", "read"]).describe("What to do."),
            server: z
                .string()
                .optional()
                .describe("MCP server name. Narrows `list`; required for `read`."),
            uri: z.string().optional().describe("Resource uri, exactly as `list` reported it. Required for `read`."),
            query: z.string().optional().describe("Substring filter over uri, name and description. `list` only."),
        }),
        execute: async ({ action, server, uri, query }) => {
            if (action === "list") return list(ctx, server, query);

            if (!server || !uri) {
                throw new Error("mcp_resource: `server` and `uri` are both required for action \"read\" — run `list` first.");
            }
            const parts = await ctx.readResource(server, uri);
            if (parts.length === 0) return `${server}:${uri} returned no contents.`;
            const body = parts
                .map((part) => (parts.length > 1 ? `--- ${part.uri || uri} ---\n${part.text}` : part.text))
                .join("\n\n");
            if (body.length <= MAX_READ_CHARS) return body;
            return `${body.slice(0, MAX_READ_CHARS)}\n\n[truncated at ${MAX_READ_CHARS} characters]`;
        },
    });
}

function list(ctx: McpResourceToolContext, server?: string, query?: string): string {
    const byServer = (entry: { server: string }) => !server || entry.server === server;
    const resources = ctx.listResources().filter((entry) => byServer(entry) && (!query || matches(entry, query)));
    const templates = ctx.listResourceTemplates().filter(byServer);

    if (resources.length === 0 && templates.length === 0) {
        const scope = server ? ` on "${server}"` : "";
        const filter = query ? ` matching "${query}"` : "";
        return `No MCP resources${scope}${filter}.`;
    }

    const sections: string[] = [];
    if (resources.length > 0) {
        const shown = resources.slice(0, MAX_LIST_ENTRIES);
        const more = resources.length - shown.length;
        sections.push(
            `Resources (${resources.length}):\n${shown.map(describe).join("\n")}` +
                (more > 0 ? `\n… ${more} more — narrow with \`query\`` : ""),
        );
    }
    if (templates.length > 0) {
        sections.push(`Templates (${templates.length}):\n${templates.map(describeTemplate).join("\n")}`);
    }
    return sections.join("\n\n");
}
