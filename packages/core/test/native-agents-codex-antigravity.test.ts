/**
 * Codex (app-server protocol) and Antigravity (`agy -p --output-format
 * stream-json`) as native agents: what each CLI is told, and how what it
 * reports is read. The fixtures are the CLIs' real output (codex-cli 0.153,
 * agy 1.3), trimmed. The Codex turn itself runs end to end in
 * native-agents-codex-app-server.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
    antigravityArgs,
    codexEffort,
    codexMcpConfig,
    codexPolicy,
    codexThreadParams,
    groupCursorModels,
    isNativeAgentProvider,
    parseAntigravityModels,
    parseCodexModels,
} from "../src/providers/native-agents";
import { mapAntigravityTool, mapCodexItem, mapCodexPlan, unwrapShell } from "../src/providers/native-agents/tool-map";

const ctx = { loopSessionId: "s1", cwd: "/repo", planMode: false, approvals: false };

describe("both are native agents", () => {
    test("loop routes them as agents that own their context", () => {
        expect(isNativeAgentProvider("codex-cli")).toBe(true);
        expect(isNativeAgentProvider("antigravity")).toBe(true);
        // t3code's own driver names must not be taken for them.
        expect(isNativeAgentProvider("codex")).toBe(false);
    });
});

describe("codex models", () => {
    const json = JSON.stringify({
        models: [
            {
                slug: "gpt-5.6-sol",
                display_name: "GPT-5.6-Sol",
                visibility: "list",
                context_window: 272000,
                default_reasoning_level: "medium",
                supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
                input_modalities: ["text", "image"],
            },
            { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", supported_reasoning_levels: [] },
        ],
    });

    test("lists the visible ones with their window and efforts", () => {
        const models = parseCodexModels(json);
        expect(models.map((m) => m.slug)).toEqual(["gpt-5.6-sol"]);
        expect(models[0]).toMatchObject({ name: "GPT-5.6-Sol", contextWindow: 272000, images: true, defaultEffort: "medium" });
    });

    test("a broken list is no models, not a crash", () => expect(parseCodexModels("not json")).toEqual([]));

    test("the thinking level maps to the nearest effort the model has", () => {
        const [sol] = parseCodexModels(json);
        expect(codexEffort(sol, "max")).toBe("xhigh");
        expect(codexEffort(sol, "none")).toBe("low");
        expect(codexEffort(sol, undefined)).toBeUndefined();
    });
});

describe("codex thread settings", () => {
    test("each loop mode maps to a sandbox and an approval policy", () => {
        expect(codexPolicy(ctx)).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
        expect(codexPolicy({ ...ctx, planMode: true })).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
        expect(codexPolicy({ ...ctx, approvals: true })).toEqual({ sandbox: "workspace-write", approvalPolicy: "untrusted" });
        expect(codexPolicy(undefined)).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
    });

    test("a utility call keeps no thread and gets no MCP servers", () => {
        const params = codexThreadParams({
            model: "m",
            ctx: undefined,
            instructions: "write a title",
            mcp: [{ name: "gh", kind: "stdio", command: "gh-mcp", args: [], deniedTools: [] }],
        });
        expect(params).toMatchObject({ model: "m", ephemeral: true, developerInstructions: "write a title" });
        expect(params.config).toBeUndefined();
    });

    test("loop's MCP servers become mcp_servers config, denied tools disabled", () => {
        expect(
            codexMcpConfig([
                { name: "gh", kind: "stdio", command: "gh-mcp", args: ["--x"], env: { T: "1" }, deniedTools: ["delete_repo"] },
                { name: "docs", kind: "http", url: "https://d.example/mcp", headers: { A: "b" }, deniedTools: [] },
            ]),
        ).toEqual({
            mcp_servers: {
                gh: { command: "gh-mcp", args: ["--x"], env: { T: "1" }, disabled_tools: ["delete_repo"] },
                docs: { url: "https://d.example/mcp", http_headers: { A: "b" } },
            },
        });
        expect(codexMcpConfig([])).toBeUndefined();
    });
});

describe("codex items as loop tools", () => {
    test("a command is bash, without the shell wrapper", () => {
        const mapped = mapCodexItem({
            id: "item_0",
            type: "commandExecution",
            command: `/bin/zsh -lc "sed -n '1,20p' note.txt"`,
            aggregatedOutput: "hello\n",
            exitCode: 0,
            status: "completed",
        });
        expect(mapped).toMatchObject({ name: "bash", input: { command: "sed -n '1,20p' note.txt" }, result: "hello\n", isError: false });
    });

    test("a failing or declined command is an error", () => {
        const failed = mapCodexItem({ type: "commandExecution", command: "false", aggregatedOutput: "", exitCode: 1, status: "failed" });
        expect(failed?.isError).toBe(true);
        expect(failed?.result).toContain("[exit 1]");
        const declined = mapCodexItem({ type: "commandExecution", command: "rm x", aggregatedOutput: null, exitCode: null, status: "declined" });
        expect(declined).toMatchObject({ isError: true, result: "\n[declined by the user]" });
    });

    test("one changed file is an edit (or a write when added) showing its diff; several are one patch", () => {
        expect(
            mapCodexItem({ type: "fileChange", changes: [{ path: "/r/a.ts", kind: { type: "update", move_path: null }, diff: "-a\n+b" }], status: "completed" }),
        ).toMatchObject({ name: "edit", input: { path: "/r/a.ts" }, result: "-a\n+b" });
        expect(mapCodexItem({ type: "fileChange", changes: [{ path: "/r/b.ts", kind: { type: "add" }, diff: "" }] })?.name).toBe("write");
        expect(
            mapCodexItem({ type: "fileChange", changes: [{ path: "a", kind: { type: "add" } }, { path: "b", kind: { type: "delete" } }] })?.name,
        ).toBe("apply_patch");
    });

    test("mcp calls keep the server__tool shape; the plan becomes loop's todo list", () => {
        expect(mapCodexItem({ type: "mcpToolCall", server: "gh", tool: "search", arguments: { q: "x" }, status: "completed" })?.name).toBe(
            "gh__search",
        );
        expect(
            mapCodexPlan([
                { step: "a", status: "completed" },
                { step: "b", status: "inProgress" },
                { step: "c", status: "pending" },
            ]).input,
        ).toEqual({
            todos: [
                { content: "a", status: "completed" },
                { content: "b", status: "in_progress" },
                { content: "c", status: "pending" },
            ],
        });
    });

    test("messages and reasoning are not tools", () => {
        expect(mapCodexItem({ type: "agentMessage", id: "m", text: "hi" })).toBeUndefined();
        expect(mapCodexItem({ type: "reasoning", id: "r", summary: [], content: [] })).toBeUndefined();
    });

    test("only a real shell wrapper is unwrapped", () => {
        expect(unwrapShell(`/bin/bash -lc "echo \\"hi\\""`)).toBe(`echo "hi"`);
        expect(unwrapShell("ls -la")).toBe("ls -la");
    });
});

describe("antigravity models", () => {
    const stdout =
        "Fetching available models...\n" +
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" +
        "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n" +
        "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n" +
        "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n";

    test("reads the tab-separated list and skips the banner", () => {
        expect(parseAntigravityModels(stdout).map((m) => m.id)).toEqual([
            "gemini-3.8-flash-high",
            "gemini-3.8-flash-medium",
            "gemini-3.8-flash-low",
            "claude-opus-4-6-thinking",
        ]);
    });

    test("efforts group into one model, named without an empty bracket", () => {
        const families = groupCursorModels(parseAntigravityModels(stdout));
        expect(families.map((f) => [f.id, f.name])).toEqual([
            ["gemini-3.8-flash", "Gemini 3.8 Flash"],
            ["claude-opus-4-6", "Claude Opus 4.6"],
        ]);
        expect(families[0].variants).toHaveLength(3);
    });
});

describe("antigravity command line", () => {
    test("the prompt rides as one --print= value, so a leading dash stays text", () => {
        const args = antigravityArgs({ model: "gemini-3.8-flash-high", prompt: "-rf everything?", ctx });
        expect(args[0]).toBe("--print=-rf everything?");
        expect(args).toContain("--dangerously-skip-permissions");
        expect(args).toContain("--disable-slash-commands");
    });

    test("resume, plan mode and utility calls", () => {
        expect(antigravityArgs({ model: "m", prompt: "p", resumeId: "c1", ctx })).toContain("c1");
        expect(antigravityArgs({ model: "m", prompt: "p", ctx: { ...ctx, planMode: true } }).slice(-2)).toEqual(["--mode", "plan"]);
        expect(antigravityArgs({ model: "m", prompt: "p" }).slice(-2)).toEqual(["--mode", "plan"]);
    });
});

describe("antigravity tools as loop tools", () => {
    test("its file and shell tools", () => {
        expect(mapAntigravityTool("run_command", { CommandLine: "cat note.txt" })).toEqual({ name: "bash", input: { command: "cat note.txt" } });
        expect(mapAntigravityTool("view_file", { AbsolutePath: "/r/a.ts", StartLine: 10, EndLine: 19 })).toEqual({
            name: "read",
            input: { path: "/r/a.ts", offset: 10, limit: 10 },
        });
        expect(mapAntigravityTool("replace_file_content", { TargetFile: "/r/a.ts" })).toEqual({ name: "edit", input: { path: "/r/a.ts" } });
        expect(mapAntigravityTool("write_to_file", { TargetFile: "/r/b.txt" })).toEqual({ name: "write", input: { path: "/r/b.txt" } });
        expect(mapAntigravityTool("browser_click_element", { x: 1 }).name).toBe("browser_click_element");
    });
});
