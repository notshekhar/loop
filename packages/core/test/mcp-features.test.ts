/**
 * Resources and prompts — the half of MCP loop never asked for.
 *
 * loop only ever called `tools/list`, so a server's resources and prompts were
 * unreachable however loudly it advertised them. These tests cover the catalog
 * (built once per connect, capability-gated so a tools-only server is never
 * asked a question it would answer with an error), the reads and prompt fetches
 * built on it, and the two surfaces that expose them: the `mcp_resource` tool
 * for the model and `@mcp:` mentions for the user.
 */
import { CONFIG_DIR_NAME } from "../src/brand";
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpManager } from "../src/mcp/manager";
import { createMcpResourceTool } from "../src/tools/mcp-resource";
import { flattenResourceContents, renderPromptMessages } from "../src/mcp/features";
import { isMcpMentionQuery, mcpMentionItems, mcpMentionToken, parseMcpMention } from "../src/mcp/mentions";
import { trustForSession } from "../src/agent/trust";
import type { McpServerConfig } from "../src/mcp/config";

const here = dirname(fileURLToPath(import.meta.url));
const FEATURES = join(here, "fixtures", "mock-mcp-features.mjs");

function features(env: Record<string, string> = {}): McpServerConfig {
    return { command: process.execPath, args: [FEATURES], ...(Object.keys(env).length ? { env } : {}) };
}

function project(servers: Record<string, McpServerConfig>): string {
    const root = mkdtempSync(join(tmpdir(), "loop-mcp-features-"));
    mkdirSync(join(root, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(root, CONFIG_DIR_NAME, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    trustForSession(root);
    return root;
}

function tempFile(name: string): string {
    return join(mkdtempSync(join(tmpdir(), "loop-mcp-features-file-")), name);
}

async function eventually(check: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** A connected manager whose catalog has finished loading. */
async function connected(env: Record<string, string> = {}): Promise<McpManager> {
    const root = project({ feat: features(env) });
    const mgr = new McpManager();
    await mgr.init(root);
    await eventually(() => mgr.listResources().length > 0 || mgr.listPrompts().length > 0);
    return mgr;
}

describe("feature catalog", () => {
    test("resources, templates and prompts are all discovered", async () => {
        const mgr = await connected();
        expect(mgr.listResources().map((r) => r.uri).sort()).toEqual([
            "blob://logo",
            "notes://roadmap",
            "notes://standup",
        ]);
        expect(mgr.listResourceTemplates().map((t) => t.uriTemplate)).toEqual(["notes://{date}/journal"]);
        expect(mgr.listPrompts().map((p) => p.name).sort()).toEqual(["review", "summarize"]);
        // Every entry knows which server it came from — two servers can both
        // publish `notes://standup` and they must stay distinguishable.
        expect(mgr.listResources().every((r) => r.server === "feat")).toBe(true);
        await mgr.close();
    });

    test("prompt arguments survive, including which are required", async () => {
        const mgr = await connected();
        const review = mgr.listPrompts().find((p) => p.name === "review");
        expect(review?.arguments).toEqual([
            { name: "path", description: "File to review", required: true },
            { name: "tone", description: "blunt or gentle" },
        ]);
        await mgr.close();
    });

    test("a tools-only server is never asked for resources or prompts", async () => {
        const callfile = tempFile("calls");
        const mgr = await (async () => {
            const root = project({ feat: features({ MOCK_MCP_CAPS: "tools", MOCK_MCP_CALLFILE: callfile }) });
            const m = new McpManager();
            await m.init(root);
            await new Promise((r) => setTimeout(r, 400));
            return m;
        })();
        const calls = existsSync(callfile) ? readFileSync(callfile, "utf8").split("\n").filter(Boolean) : [];
        expect(calls).toContain("tools/list");
        // Asking anyway would earn a method-not-found on every single connect.
        expect(calls).not.toContain("resources/list");
        expect(calls).not.toContain("prompts/list");
        expect(mgr.listResources()).toEqual([]);
        expect(mgr.getServer("feat")?.status).toBe("ready");
        await mgr.close();
    });

    test("a paginated resource list is walked to the end", async () => {
        const mgr = await connected({ MOCK_MCP_PAGED: "1" });
        await eventually(() => mgr.listResources().length === 3);
        expect(mgr.listResources()).toHaveLength(3);
        await mgr.close();
    });

    test("the server's own instructions are kept, not dropped", async () => {
        const mgr = await connected();
        expect(mgr.getServer("feat")?.instructions).toContain("Notes live under notes://");
        await mgr.close();
    });

    test("declared capabilities are read off the handshake", async () => {
        const mgr = await connected();
        const caps = mgr.getServer("feat")?.capabilities;
        expect(caps?.resources).toBe(true);
        expect(caps?.resourceSubscribe).toBe(true);
        expect(caps?.prompts).toBe(true);
        expect(mgr.supportsResourceSubscribe("feat")).toBe(true);
        await mgr.close();
    });
});

describe("reading resources and prompts", () => {
    test("a text resource comes back as text", async () => {
        const mgr = await connected();
        const parts = await mgr.readResource("feat", "notes://standup");
        expect(parts).toHaveLength(1);
        expect(parts[0].text).toBe("contents of standup");
        expect(parts[0].binary).toBe(false);
        await mgr.close();
    });

    test("a binary resource is described, never inlined as base64", async () => {
        const mgr = await connected();
        const [part] = await mgr.readResource("feat", "blob://logo");
        expect(part.binary).toBe(true);
        expect(part.text).toContain("image/png");
        expect(part.text).toContain("bytes");
        // The base64 itself must not reach the transcript: it is unreadable and
        // enormous, and one of these can blow a whole context window.
        expect(part.text).not.toContain("bm90IHJlYWxseQ");
        await mgr.close();
    });

    test("reading from a server that isn't connected says so", async () => {
        const mgr = await connected();
        await expect(mgr.readResource("nope", "notes://standup")).rejects.toThrow(/unknown MCP server: nope/);
        await mgr.close();
    });

    test("a prompt renders to text with its arguments applied", async () => {
        const mgr = await connected();
        const text = await mgr.getPrompt("feat", "review", { path: "src/app.ts" });
        expect(text).toContain('review: {"path":"src/app.ts"}');
        // An assistant turn in a prompt is labelled — run together unattributed
        // it reads as the user having said it.
        expect(text).toContain("[assistant]\nunderstood");
        await mgr.close();
    });

    test("argument completion comes from the server", async () => {
        const mgr = await connected();
        const values = await mgr.completeArgument("feat", { type: "ref/prompt", name: "review" }, {
            name: "path",
            value: "src/",
        });
        expect(values).toEqual(["src/index.ts", "src/app.ts"]);
        await mgr.close();
    });

    test("completion on a server that never declared it returns nothing, and does not throw", async () => {
        const mgr = await connected({ MOCK_MCP_CAPS: "tools,resources,prompts" });
        const values = await mgr.completeArgument("feat", { type: "ref/prompt", name: "review" }, {
            name: "path",
            value: "src/",
        });
        expect(values).toEqual([]);
        await mgr.close();
    });
});

describe("mcp_resource tool", () => {
    async function toolFor(mgr: McpManager) {
        const tool = createMcpResourceTool({
            listResources: () => mgr.listResources(),
            listResourceTemplates: () => mgr.listResourceTemplates(),
            readResource: (server, uri) => mgr.readResource(server, uri),
        }) as { execute: (input: unknown, options: unknown) => Promise<string> };
        return tool;
    }

    test("list reports resources and templates separately", async () => {
        const mgr = await connected();
        const out = await (await toolFor(mgr)).execute({ action: "list" }, {});
        expect(out).toContain("Resources (3)");
        expect(out).toContain("feat:notes://standup");
        expect(out).toContain("Templates (1)");
        expect(out).toContain("notes://{date}/journal");
        await mgr.close();
    });

    test("list narrows by query", async () => {
        const mgr = await connected();
        const out = await (await toolFor(mgr)).execute({ action: "list", query: "roadmap" }, {});
        expect(out).toContain("notes://roadmap");
        expect(out).not.toContain("notes://standup");
        await mgr.close();
    });

    test("read without a uri explains what's missing instead of guessing", async () => {
        const mgr = await connected();
        await expect((await toolFor(mgr)).execute({ action: "read", server: "feat" }, {})).rejects.toThrow(
            /`server` and `uri` are both required/,
        );
        await mgr.close();
    });

    test("read returns the contents", async () => {
        const mgr = await connected();
        const out = await (await toolFor(mgr)).execute({ action: "read", server: "feat", uri: "notes://roadmap" }, {});
        expect(out).toBe("contents of roadmap");
        await mgr.close();
    });
});

describe("@mcp mentions", () => {
    const entries = [
        { server: "feat", uri: "notes://standup", name: "standup", description: "Today's standup notes" },
        { server: "other", uri: "repo://issues", name: "issues" },
    ];

    test("only an mcp: query offers resources — a bare @ stays file-only", () => {
        expect(isMcpMentionQuery("@")).toBe(true); // "" is a prefix of "mcp:"
        expect(isMcpMentionQuery("@mc")).toBe(true);
        expect(isMcpMentionQuery("@mcp:feat")).toBe(true);
        expect(isMcpMentionQuery("@src/app.ts")).toBe(false);
        expect(mcpMentionItems("@src/app.ts", entries)).toEqual([]);
    });

    test("matching works by server or by uri", () => {
        expect(mcpMentionItems("@mcp:feat", entries).map((i) => i.value)).toEqual(["@mcp:feat:notes://standup"]);
        expect(mcpMentionItems("@mcp:issues", entries).map((i) => i.value)).toEqual(["@mcp:other:repo://issues"]);
        expect(mcpMentionItems("@mcp:", entries)).toHaveLength(2);
    });

    test("a mention round-trips, colons in the uri and all", () => {
        const token = mcpMentionToken({ server: "feat", uri: "repo://owner/name/issues" });
        expect(token).toBe("@mcp:feat:repo://owner/name/issues");
        // Splitting greedily on ":" would hand back a server name of "repo".
        expect(parseMcpMention(token)).toEqual({ server: "feat", uri: "repo://owner/name/issues" });
        expect(parseMcpMention("@src/app.ts")).toBeUndefined();
        expect(parseMcpMention("@mcp:feat")).toBeUndefined();
    });
});

describe("content flattening", () => {
    test("text and blob parts are distinguished", () => {
        const parts = flattenResourceContents([
            { uri: "a://1", mimeType: "text/plain", text: "hello" },
            { uri: "a://2", mimeType: "application/pdf", blob: "AAAA" },
            "not an object",
        ]);
        expect(parts).toHaveLength(2);
        expect(parts[0]).toEqual({ uri: "a://1", mimeType: "text/plain", text: "hello", binary: false });
        expect(parts[1].binary).toBe(true);
        expect(parts[1].text).toContain("3 bytes");
    });

    test("prompt messages render, skipping what cannot be shown", () => {
        const text = renderPromptMessages([
            { role: "user", content: { type: "text", text: "first" } },
            { role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
            { role: "user", content: { type: "resource", resource: { uri: "a://1", text: "embedded" } } },
        ]);
        expect(text).toBe("first\n\n[image omitted]\n\na://1\nembedded");
    });
});
