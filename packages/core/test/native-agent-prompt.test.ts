/**
 * What loop hands a native agent from its own config: the project context it
 * doesn't load itself, and loop's MCP servers it can safely run. Settings and
 * the session DB are temporary; the "repo" is a temp folder.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "loop-native-prompt-home-"));
const actualBrand = await import("../src/brand");
mock.module("../src/brand", () => ({ ...actualBrand, getConfigDir: () => join(home, ".loop") }));
const settings: Record<string, unknown> = {};
const actualSettings = await import("../src/settings");
mock.module("../src/settings", () => ({ ...actualSettings, getSetting: (k: string) => settings[k] }));

const { buildNativeAgentPrompt } = await import("../src/agent/turn/native-agent");
const { nativeMcpServers } = await import("../src/providers/native-agents/mcp-servers");
const { useTempSessionDb } = await import("./helpers/temp-db");
useTempSessionDb();

const repo = mkdtempSync(join(tmpdir(), "loop-native-prompt-repo-"));
mkdirSync(join(repo, ".git"));
writeFileSync(join(repo, "AGENTS.md"), "AGENTS RULES");
writeFileSync(join(repo, "CLAUDE.md"), "CLAUDE RULES");
const project = { workspaceContext: "", memoryContext: "<memory>loop memory</memory>", skills: [], skillsPrompt: "<available_skills/>" };

describe("loop's prompt for a native agent", () => {
    test("Claude Code gets AGENTS.md (which it never reads) but not CLAUDE.md (which it does)", () => {
        const prompt = buildNativeAgentPrompt("claude-code", repo, project);
        expect(prompt).toContain("AGENTS RULES");
        expect(prompt).not.toContain("CLAUDE RULES");
    });

    test("Codex gets CLAUDE.md but not AGENTS.md", () => {
        const prompt = buildNativeAgentPrompt("codex-cli", repo, project);
        expect(prompt).toContain("CLAUDE RULES");
        expect(prompt).not.toContain("AGENTS RULES");
    });

    test("memory and skills always ride along; nothing at all is an empty prompt", () => {
        const prompt = buildNativeAgentPrompt("cursor-agent", repo, project);
        expect(prompt).toContain("loop memory");
        expect(prompt).toContain("<available_skills/>");
        expect(prompt).not.toContain("RULES");
        expect(buildNativeAgentPrompt("cursor-agent", repo, { ...project, memoryContext: "", skillsPrompt: "" })).toBe("");
    });
});

describe("loop's MCP servers for a native agent", () => {
    test("enabled static servers pass; disabled, OAuth and allowedTools-limited ones don't", () => {
        process.env.LOOP_TEST_MCP_TOKEN = "tok";
        settings.mcpServers = {
            gh: { command: "gh-mcp", args: ["-v"], deniedTools: ["delete_repo"] },
            docs: { type: "http", url: "https://d/mcp", headers: { Authorization: "Bearer ${env:LOOP_TEST_MCP_TOKEN}" } },
            off: { command: "x", enabled: false },
            figma: { type: "http", url: "https://f/mcp", auth: "oauth" },
            narrow: { command: "y", allowedTools: ["one"] },
        };
        expect(nativeMcpServers(repo)).toEqual([
            { name: "gh", kind: "stdio", command: "gh-mcp", args: ["-v"], deniedTools: ["delete_repo"] },
            { name: "docs", kind: "http", url: "https://d/mcp", headers: { Authorization: "Bearer tok" }, deniedTools: [] },
        ]);
    });

    test("nothing when MCP is off", () => {
        settings.mcp = false;
        settings.mcpServers = { gh: { command: "gh-mcp" } };
        expect(nativeMcpServers(repo)).toEqual([]);
        delete settings.mcp;
    });
});
