/**
 * `mcp_tools` — search-and-call, for setups with more MCP tools than a request
 * should carry.
 *
 * Every advertised tool's name, description and full input schema is sent on
 * EVERY request. Two or three chatty servers (a GitHub server, a Jira server, a
 * browser server) will happily cost more context than loop's entire builtin
 * toolset, before the model has read a single file — and most of those tools
 * are irrelevant to any given turn.
 *
 * So above a threshold the individual tools stop being advertised and this one
 * takes their place: the model searches for what it needs, reads that tool's
 * schema, and calls it. The tools themselves are unchanged — same namespaced
 * names, same timeout and disconnect wrapping — they are simply reached through
 * one door instead of five hundred.
 */
import { tool } from "ai";
import { z } from "zod";

export const MCP_TOOLS_TOOL_NAME = "mcp_tools";

/** One advertised-tool-shaped thing: what the AI SDK hands back from client.tools(). */
interface McpToolLike {
    description?: string;
    inputSchema?: unknown;
    execute?: (input: unknown, options: unknown) => Promise<unknown>;
}

export interface McpToolsToolContext {
    /** The namespaced MCP tool set this turn would otherwise have advertised. */
    tools: () => Record<string, unknown>;
}

const MAX_RESULTS = 25;

/** First sentence (or first line) of a description — enough to choose by. */
function summarize(description: string | undefined, max = 160): string {
    if (!description) return "";
    const firstLine = description.split("\n").find((line) => line.trim()) ?? "";
    return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/**
 * Score a tool against a query.
 *
 * Deliberately simple and explainable — a name hit outranks a description hit,
 * and every query term must appear somewhere. A model that searches "issue"
 * and gets a ranked-by-magic list it can't predict just searches again.
 */
export function scoreTool(name: string, description: string, query: string): number {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return 1;
    const lowerName = name.toLowerCase();
    const lowerDescription = description.toLowerCase();
    let score = 0;
    for (const term of terms) {
        const inName = lowerName.includes(term);
        const inDescription = lowerDescription.includes(term);
        if (!inName && !inDescription) return 0;
        score += inName ? 2 : 1;
        if (lowerName === term) score += 3;
    }
    return score;
}

/** JSON Schema for one tool, as text the model can read before calling it. */
function renderSchema(input: unknown): string {
    if (input === undefined || input === null) return "(no parameters)";
    try {
        // AI SDK tools carry either a JSON schema or a zod schema; the former
        // stringifies usefully, and the latter at least names its keys.
        const schema = (input as { jsonSchema?: unknown }).jsonSchema ?? input;
        return JSON.stringify(schema, null, 2);
    } catch {
        return "(schema unavailable)";
    }
}

export function createMcpToolsTool(ctx: McpToolsToolContext) {
    return tool({
        description:
            "Search and call the tools published by connected MCP servers. There are too many of them to list " +
            "in every request, so they are reached through this tool instead.\n\n" +
            "- search: find tools by keyword. Returns namespaced names (`mcp__<server>__<tool>`) with summaries.\n" +
            "- describe: the full input schema for one tool — read this before calling anything unfamiliar.\n" +
            "- call: run one tool, passing its arguments as an object.\n\n" +
            "Search first. Names are server-specific and not guessable; calling a tool you have not described is " +
            "how you send the wrong arguments.",
        inputSchema: z.object({
            action: z.enum(["search", "describe", "call"]).describe("What to do."),
            query: z.string().optional().describe("Keywords. `search` only; omit to list everything."),
            name: z
                .string()
                .optional()
                .describe("Namespaced tool name from `search`. Required for `describe` and `call`."),
            arguments: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Arguments object for `call`, matching the tool's input schema."),
        }),
        execute: async ({ action, query, name, arguments: args }, options) => {
            const tools = ctx.tools() as Record<string, McpToolLike>;

            if (action === "search") {
                const scored = Object.entries(tools)
                    .map(([toolName, entry]) => ({
                        name: toolName,
                        description: summarize(entry?.description),
                        score: scoreTool(toolName, entry?.description ?? "", query ?? ""),
                    }))
                    .filter((entry) => entry.score > 0)
                    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
                if (scored.length === 0) {
                    return `No MCP tools match "${query ?? ""}". ${Object.keys(tools).length} tools are connected — try a broader term.`;
                }
                const shown = scored.slice(0, MAX_RESULTS);
                const more = scored.length - shown.length;
                const lines = shown.map((entry) =>
                    entry.description ? `${entry.name} — ${entry.description}` : entry.name,
                );
                return (
                    `${scored.length} match${scored.length === 1 ? "" : "es"}:\n${lines.join("\n")}` +
                    (more > 0 ? `\n… ${more} more — narrow the query` : "")
                );
            }

            if (!name) {
                throw new Error(`mcp_tools: \`name\` is required for action "${action}" — run \`search\` first.`);
            }
            const entry = tools[name];
            if (!entry) {
                // Naming the near-misses turns a dead end into a next step.
                const near = Object.keys(tools)
                    .filter((candidate) => candidate.includes(name) || name.includes(candidate))
                    .slice(0, 5);
                throw new Error(
                    `mcp_tools: no tool named "${name}".` + (near.length ? ` Did you mean: ${near.join(", ")}?` : ""),
                );
            }

            if (action === "describe") {
                return [`${name}`, entry.description ?? "(no description)", "", renderSchema(entry.inputSchema)].join(
                    "\n",
                );
            }

            if (typeof entry.execute !== "function") {
                throw new Error(`mcp_tools: "${name}" cannot be called directly.`);
            }
            // Options are forwarded so the underlying tool keeps the turn's
            // abort signal — a cancelled turn must cancel the MCP call too,
            // not leave it running against the server.
            return (await entry.execute(args ?? {}, options)) as unknown;
        },
    });
}

/**
 * Guidance for the turn's system prompt when search mode is on.
 *
 * Without it the model sees one unfamiliar tool where it expected the server
 * tools it was told about, and the usual failure is that it never searches —
 * it just reports that the capability is missing.
 */
export function buildMcpToolSearchNote(toolCount: number, serverNames: string[]): string {
    return `\n\nMCP tools (${toolCount} of them, from ${serverNames.join(", ")}) are NOT listed individually in this conversation — there are too many to carry in every request. Reach them with the ${MCP_TOOLS_TOOL_NAME} tool: search by keyword, describe the one you want, then call it. When a task needs a connected server, search before concluding you cannot do it.`;
}
