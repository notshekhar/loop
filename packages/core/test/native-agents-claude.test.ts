/**
 * Claude Code as a native agent: how its permission requests are answered,
 * how its SDK messages are read, and what it is handed from loop's config.
 * Settings and the session DB are temporary — nothing touches ~/.loop.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { CanUseTool, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { BashApprovalDecision, BashApprovalRequest } from "../src/tools/approval-bridge";

const home = mkdtempSync(join(tmpdir(), "loop-claude-home-"));
const actualBrand = await import("../src/brand");
mock.module("../src/brand", () => ({ ...actualBrand, getConfigDir: () => join(home, ".loop") }));
const settings: Record<string, unknown> = {};
const actualSettings = await import("../src/settings");
mock.module("../src/settings", () => ({
    ...actualSettings,
    getSetting: (k: string) => settings[k],
    setSetting: (k: string, v: unknown) => {
        settings[k] = v;
    },
}));

const { permissionOptions, describeUpdates } = await import("../src/providers/native-agents/claude-code-permissions");
const { ClaudeTurnReader } = await import("../src/providers/native-agents/claude-code-events");
const { claudeMcpOptions } = await import("../src/providers/native-agents/claude-code");
const { setBashApprovalBridge } = await import("../src/tools/approval-bridge");
const { useTempSessionDb } = await import("./helpers/temp-db");
useTempSessionDb();

const cwd = mkdtempSync(join(tmpdir(), "loop-claude-cwd-"));
const ctx = { loopSessionId: "s1", cwd, planMode: false, approvals: true };

let asked: BashApprovalRequest[] = [];
function answerWith(decision: BashApprovalDecision): void {
    setBashApprovalBridge({
        confirm: async (req) => {
            asked.push(req);
            return decision;
        },
    });
}

beforeEach(() => {
    asked = [];
    for (const k of Object.keys(settings)) delete settings[k];
    settings.bashApprove = true;
});

function callback(): CanUseTool {
    const cb = permissionOptions(ctx).canUseTool;
    if (!cb) throw new Error("expected loop to answer Claude's permission requests");
    return cb;
}
const opts = (suggestions: PermissionUpdate[] = []) => ({ signal: new AbortController().signal, toolUseID: "t1", suggestions });

describe("claude code permission requests", () => {
    test("'always allow' on a Bash command is remembered — the next one isn't asked", async () => {
        answerWith("always");
        const first = await callback()("Bash", { command: "npm test" }, opts());
        expect(first.behavior).toBe("allow");
        const second = await callback()("Bash", { command: "npm test" }, opts());
        expect(second.behavior).toBe("allow");
        // Asked once, and offered something to remember.
        expect(asked).toHaveLength(1);
        expect(asked[0].patterns).toEqual(["npm test"]);
    });

    test("loop's denylist refuses Claude's command without asking", async () => {
        answerWith("once");
        settings.bashDeny = ["git push"];
        const result = await callback()("Bash", { command: "git push origin main" }, opts());
        expect(result.behavior).toBe("deny");
        expect(asked).toHaveLength(0);
    });

    test("another tool offers Claude's own suggested rule, and 'always' hands it back to Claude", async () => {
        answerWith("always");
        const suggestion: PermissionUpdate = {
            type: "addRules",
            rules: [{ toolName: "Edit", ruleContent: "/r/**" }],
            behavior: "allow",
            destination: "session",
        };
        const result = await callback()("Edit", { file_path: "/r/a.ts" }, opts([suggestion]));
        expect(asked[0]).toMatchObject({ kind: "tool", command: "/r/a.ts", patterns: ["Edit(/r/**)"] });
        expect(result).toMatchObject({ behavior: "allow", updatedPermissions: [suggestion] });
    });

    test("plan mode asks before any command, even with bashApprove off", async () => {
        settings.bashApprove = false;
        answerWith("deny");
        const cb = permissionOptions({ ...ctx, planMode: true, approvals: false }).canUseTool!;
        const result = await cb("Bash", { command: "touch x" }, opts());
        expect(result.behavior).toBe("deny");
        expect(asked).toHaveLength(1);
    });

    test("suggestions read as rules", () => {
        expect(
            describeUpdates([
                { type: "addRules", rules: [{ toolName: "WebFetch" }, { toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" },
                { type: "addDirectories", directories: ["/tmp/x"], destination: "session" },
            ]),
        ).toEqual(["WebFetch", "Bash(ls:*)", "access to /tmp/x"]);
    });
});

describe("claude code messages", () => {
    function reader(progress?: { text: unknown[]; tool: unknown[] }) {
        const parts: LanguageModelV4StreamPart[] = [];
        const r = new ClaudeTurnReader((p) => parts.push(p), {
            modelId: "sonnet",
            plan: { text: "hi", images: [], seen: 1 },
            ctx: undefined,
            progress: progress && {
                text: (...a) => progress.text.push(a),
                tool: (...a) => progress.tool.push(a),
            },
        });
        return { r, parts };
    }
    const init = (apiKeySource: string) =>
        ({ type: "system", subtype: "init", session_id: "cc-1", model: "claude-sonnet", apiKeySource }) as never;
    const result = (cost: number) =>
        ({ type: "result", subtype: "success", is_error: false, usage: { output_tokens: 5 }, total_cost_usd: cost, num_turns: 1 }) as never;
    const finishOf = (parts: LanguageModelV4StreamPart[]) =>
        parts.find((p) => p.type === "finish") as Extract<LanguageModelV4StreamPart, { type: "finish" }>;

    test("a subagent's prose and tool calls reach the task box live", () => {
        const progress = { text: [] as unknown[], tool: [] as unknown[] };
        const { r } = reader(progress);
        r.read({
            type: "assistant",
            message: { id: "m1", content: [{ type: "tool_use", id: "task-1", name: "Task", input: { subagent_type: "Explore", prompt: "look" } }] },
        } as never);
        r.read({
            type: "assistant",
            parent_tool_use_id: "task-1",
            message: {
                id: "m2",
                content: [
                    { type: "text", text: "Searching" },
                    { type: "tool_use", id: "g1", name: "Grep", input: { pattern: "foo" } },
                ],
            },
        } as never);
        expect(progress.text).toEqual([["task-1", "Explore", "Searching\n"]]);
        expect(progress.tool).toEqual([["task-1", "Explore", "grep", { pattern: "foo" }]]);
    });

    test("an API-key login reports the turn's cost as billed; a subscription doesn't", () => {
        const keyed = reader();
        keyed.r.read(init("ANTHROPIC_API_KEY"));
        keyed.r.read(result(0.42));
        expect(finishOf(keyed.parts).providerMetadata?.["claude-code"]).toMatchObject({ billedUsd: 0.42 });

        const plan = reader();
        plan.r.read(init("oauth"));
        plan.r.read(result(0.42));
        expect(finishOf(plan.parts).providerMetadata?.["claude-code"]?.billedUsd).toBeUndefined();
    });
});

describe("loop's MCP servers for claude code", () => {
    test("each server in the SDK's shape, denied tools disallowed", () => {
        expect(
            claudeMcpOptions([
                { name: "gh", kind: "stdio", command: "gh-mcp", args: [], deniedTools: ["delete_repo"] },
                { name: "docs", kind: "sse", url: "https://d/mcp", deniedTools: [] },
            ]),
        ).toEqual({
            mcpServers: { gh: { type: "stdio", command: "gh-mcp", args: [] }, docs: { type: "sse", url: "https://d/mcp" } },
            disallowedTools: ["mcp__gh__delete_repo"],
        });
        expect(claudeMcpOptions([])).toEqual({});
    });
});
