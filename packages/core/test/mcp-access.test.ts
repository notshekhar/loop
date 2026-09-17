/**
 * Which MCP tools a turn actually carries: per-server allow/deny policy, and
 * the search door for setups too large to advertise.
 *
 * Connecting used to be all-or-nothing — every tool a server exposed joined
 * every turn. That is a context problem (a couple of verbose servers can
 * outweigh loop's entire builtin toolset before a single file is read) and a
 * safety one: a server whose read tools you want may also ship a destructive
 * one you do not.
 */
import { CONFIG_DIR_NAME } from "../src/brand";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpManager } from "../src/mcp/manager";
import { hasToolPolicy, isToolAllowed, shouldUseToolSearch, DEFAULT_TOOL_SEARCH_THRESHOLD } from "../src/mcp/config";
import { buildMcpToolSearchNote, createMcpToolsTool, scoreTool } from "../src/tools/mcp-tools";
import { getSetting, setSetting } from "../src/settings";
import { trustForSession } from "../src/agent/trust";
import type { McpServerConfig } from "../src/mcp/config";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "fixtures", "mock-mcp-server.mjs");

function project(servers: Record<string, McpServerConfig>): string {
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-access-"));
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    trustForSession(root);
    return root;
}

/** The fixture exposes exactly two tools: `echo` and `structured`. */
function stdio(policy: Partial<McpServerConfig> = {}): McpServerConfig {
    return { command: process.execPath, args: [MOCK], ...policy } as McpServerConfig;
}

describe("tool access policy", () => {
    test("deny beats allow, and an empty allow list means nothing", () => {
        expect(isToolAllowed({}, "echo")).toBe(true);
        expect(isToolAllowed({ deniedTools: ["echo"] }, "echo")).toBe(false);
        expect(isToolAllowed({ allowedTools: ["echo"] }, "structured")).toBe(false);
        // Both listed: the denial wins, which is the combination people write.
        expect(isToolAllowed({ allowedTools: ["echo"], deniedTools: ["echo"] }, "echo")).toBe(false);
        // An empty list granting everything is a surprise that only goes one way.
        expect(isToolAllowed({ allowedTools: [] }, "echo")).toBe(false);
        expect(hasToolPolicy({})).toBe(false);
        expect(hasToolPolicy({ deniedTools: [] })).toBe(false);
        expect(hasToolPolicy({ allowedTools: [] })).toBe(true);
    });

    test("a denied tool is never advertised at all", async () => {
        const mgr = new McpManager();
        await mgr.init(project({ fs: stdio({ deniedTools: ["structured"] }) }));
        expect(Object.keys(mgr.getTools())).toEqual(["mcp__fs__echo"]);
        // Not merely blocked at call time — it never reaches the model, so no
        // tokens are spent on its schema and nothing is planned around it.
        expect(mgr.getServer("fs")?.toolCount).toBe(1);
        await mgr.close();
    });

    test("an allow list keeps only what it names", async () => {
        const mgr = new McpManager();
        await mgr.init(project({ fs: stdio({ allowedTools: ["structured"] }) }));
        expect(Object.keys(mgr.getTools())).toEqual(["mcp__fs__structured"]);
        await mgr.close();
    });

    test("the policy is written against the server's names, not loop's keys", async () => {
        // `mcp__fs__echo` is loop's key; `echo` is the name the server
        // documents — and the key is shortened when long, so matching on it
        // would break on exactly the verbose servers policies are written for.
        const mgr = new McpManager();
        await mgr.init(project({ fs: stdio({ deniedTools: ["mcp__fs__echo"] }) }));
        expect(Object.keys(mgr.getTools()).sort()).toEqual(["mcp__fs__echo", "mcp__fs__structured"]);
        await mgr.close();
    });

    test("a policy that filters everything still leaves a connected server", async () => {
        const mgr = new McpManager();
        await mgr.init(project({ fs: stdio({ allowedTools: [] }) }));
        expect(mgr.getTools()).toEqual({});
        // Connected, with zero tools — not an error. Its resources and prompts
        // are still reachable.
        expect(mgr.getServer("fs")?.status).toBe("ready");
        await mgr.close();
    });
});

describe("search-mode threshold", () => {
    const saved = getSetting("mcpToolSearch");
    beforeEach(() => setSetting("mcpToolSearch", undefined as never));
    afterEach(() => setSetting("mcpToolSearch", saved as never));

    test("the default only trips on a genuinely large setup", () => {
        expect(shouldUseToolSearch(DEFAULT_TOOL_SEARCH_THRESHOLD)).toBe(false);
        expect(shouldUseToolSearch(DEFAULT_TOOL_SEARCH_THRESHOLD + 1)).toBe(true);
        expect(shouldUseToolSearch(0)).toBe(false);
    });

    test("false never searches, true always does, a number moves the line", () => {
        setSetting("mcpToolSearch", false as never);
        expect(shouldUseToolSearch(10_000)).toBe(false);
        setSetting("mcpToolSearch", true as never);
        expect(shouldUseToolSearch(0)).toBe(true);
        setSetting("mcpToolSearch", 5 as never);
        expect(shouldUseToolSearch(5)).toBe(false);
        expect(shouldUseToolSearch(6)).toBe(true);
    });

    test("a nonsense value falls back to the default rather than guessing", () => {
        setSetting("mcpToolSearch", "lots" as never);
        expect(shouldUseToolSearch(DEFAULT_TOOL_SEARCH_THRESHOLD + 1)).toBe(true);
        expect(shouldUseToolSearch(1)).toBe(false);
    });
});

describe("mcp_tools", () => {
    const tools = {
        mcp__gh__create_issue: { description: "Create an issue in a repository.", execute: async () => "created" },
        mcp__gh__list_issues: { description: "List issues.", execute: async () => "listed" },
        mcp__jira__create_ticket: {
            description: "Open a ticket.\nSecond line, not shown in search.",
            inputSchema: { type: "object", properties: { title: { type: "string" } } },
            execute: async (input: unknown) => `ticket ${JSON.stringify(input)}`,
        },
    };
    const tool = () =>
        createMcpToolsTool({ tools: () => tools }) as unknown as {
            execute: (input: unknown, options: unknown) => Promise<string>;
        };

    test("ranking puts a name hit above a description hit", () => {
        expect(scoreTool("mcp__gh__create_issue", "Create an issue", "issue")).toBeGreaterThan(
            scoreTool("mcp__gh__other", "issue tracking", "issue"),
        );
        // Every term must appear somewhere.
        expect(scoreTool("mcp__gh__create_issue", "Create an issue", "issue banana")).toBe(0);
        // An empty query matches everything, which is how `search` lists.
        expect(scoreTool("anything", "", "")).toBe(1);
    });

    test("search returns matches with one-line summaries", async () => {
        const out = await tool().execute({ action: "search", query: "create" }, {});
        expect(out).toContain("mcp__gh__create_issue");
        expect(out).toContain("mcp__jira__create_ticket");
        expect(out).not.toContain("list_issues");
        // Multi-line descriptions are summarized, not dumped.
        expect(out).not.toContain("Second line");
    });

    test("a miss says how many tools there are instead of just failing", async () => {
        const out = await tool().execute({ action: "search", query: "kubernetes" }, {});
        expect(out).toContain("No MCP tools match");
        expect(out).toContain("3 tools are connected");
    });

    test("describe returns the schema to call with", async () => {
        const out = await tool().execute({ action: "describe", name: "mcp__jira__create_ticket" }, {});
        expect(out).toContain("Open a ticket");
        expect(out).toContain('"title"');
    });

    test("call runs the real tool and passes its arguments through", async () => {
        const out = await tool().execute(
            { action: "call", name: "mcp__jira__create_ticket", arguments: { title: "hi" } },
            {},
        );
        expect(out).toBe('ticket {"title":"hi"}');
    });

    test("an unknown name suggests the near misses", async () => {
        await expect(tool().execute({ action: "call", name: "create_issue" }, {})).rejects.toThrow(
            /no tool named "create_issue".*Did you mean: mcp__gh__create_issue/s,
        );
    });

    test("describe and call without a name say to search first", async () => {
        await expect(tool().execute({ action: "describe" }, {})).rejects.toThrow(/`name` is required/);
    });

    test("the tool set is read per call, so a server connecting mid-turn is visible", async () => {
        const live: Record<string, { description: string; execute: () => Promise<string> }> = {};
        const searcher = createMcpToolsTool({ tools: () => live }) as unknown as {
            execute: (input: unknown, options: unknown) => Promise<string>;
        };
        expect(await searcher.execute({ action: "search", query: "late" }, {})).toContain("0 tools are connected");
        live.mcp__late__joiner = { description: "Arrived late.", execute: async () => "ok" };
        expect(await searcher.execute({ action: "search", query: "late" }, {})).toContain("mcp__late__joiner");
    });

    test("the prompt note names the servers, so the model knows what it can reach", () => {
        const note = buildMcpToolSearchNote(212, ["gh", "jira"]);
        expect(note).toContain("212");
        expect(note).toContain("gh, jira");
        expect(note).toContain("mcp_tools");
        // The failure this prevents: concluding the capability is missing.
        expect(note).toContain("search before concluding you cannot do it");
    });
});
