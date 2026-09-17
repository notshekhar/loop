/**
 * `@mcp:<server>:<uri>` — MCP resources in the composer.
 *
 * loop's `@` completions insert a token and stop there; nothing expands a
 * mention into content, because the agent already has a tool for reading what
 * the user pointed at (`read` for files, `mcp_resource` for these). So this is
 * purely a naming and completion concern: produce a token the model can act on
 * and the user can type without memorising a uri.
 *
 * The `mcp:` prefix is load-bearing. Resources are only offered once the query
 * starts with it — a bare `@` stays exactly as fast and as file-only as it has
 * always been, which matters when a connected server publishes hundreds of
 * resources and would otherwise bury every file suggestion.
 */
import type { McpResourceEntry } from "./features";

export const MCP_MENTION_PREFIX = "mcp:";

export interface McpMentionItem {
    /** Inserted into the composer, leading `@` included, like file completions. */
    value: string;
    label: string;
    description?: string;
}

/** Is this `@` query asking for MCP resources rather than files? */
export function isMcpMentionQuery(query: string): boolean {
    const q = query.startsWith("@") ? query.slice(1) : query;
    // A partial prefix counts, so the list appears while "mcp:" is being typed.
    return MCP_MENTION_PREFIX.startsWith(q.toLowerCase()) || q.toLowerCase().startsWith(MCP_MENTION_PREFIX);
}

/** The `<server>:<uri>` part of a query, or "" while the user is still typing `mcp:`. */
function mentionBody(query: string): string {
    const q = query.startsWith("@") ? query.slice(1) : query;
    return q.toLowerCase().startsWith(MCP_MENTION_PREFIX) ? q.slice(MCP_MENTION_PREFIX.length) : "";
}

export function mcpMentionToken(entry: Pick<McpResourceEntry, "server" | "uri">): string {
    return `@${MCP_MENTION_PREFIX}${entry.server}:${entry.uri}`;
}

/**
 * Completion items for an `@mcp:…` query.
 *
 * Matching is a case-insensitive substring over the whole token, so both
 * `@mcp:github` (narrow to a server) and `@mcp:issues` (find by uri, whichever
 * server it lives on) work — people reach for either.
 */
export function mcpMentionItems(query: string, entries: McpResourceEntry[], limit = 20): McpMentionItem[] {
    if (!isMcpMentionQuery(query)) return [];
    const body = mentionBody(query).toLowerCase();
    const items: McpMentionItem[] = [];
    for (const entry of entries) {
        const token = `${entry.server}:${entry.uri}`;
        const haystack = `${token} ${entry.name} ${entry.title ?? ""} ${entry.description ?? ""}`.toLowerCase();
        if (body && !haystack.includes(body)) continue;
        items.push({
            value: mcpMentionToken(entry),
            label: token,
            ...(entry.title || entry.description || entry.name
                ? { description: entry.description ?? entry.title ?? entry.name }
                : {}),
        });
        if (items.length >= limit) break;
    }
    return items;
}

/**
 * Read a mention back into its parts.
 *
 * Split on the FIRST colon after the prefix and no further: a uri is itself
 * full of colons (`repo://owner/name`), so anything that splits greedily hands
 * back a server name that was never there.
 */
export function parseMcpMention(token: string): { server: string; uri: string } | undefined {
    const raw = token.startsWith("@") ? token.slice(1) : token;
    if (!raw.toLowerCase().startsWith(MCP_MENTION_PREFIX)) return undefined;
    const body = raw.slice(MCP_MENTION_PREFIX.length);
    const colon = body.indexOf(":");
    if (colon <= 0 || colon === body.length - 1) return undefined;
    return { server: body.slice(0, colon), uri: body.slice(colon + 1) };
}
