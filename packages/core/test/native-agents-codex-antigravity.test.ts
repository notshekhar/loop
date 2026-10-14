/**
 * Codex (`codex exec --json`) and Antigravity (`agy -p --output-format
 * stream-json`) as native agents: what each CLI is told, and how what it
 * reports is read. The fixtures are the CLIs' real output (codex-cli 0.153,
 * agy 1.3), trimmed.
 */
import { describe, expect, test } from "bun:test";
import {
    antigravityArgs,
    codexArgs,
    codexEffort,
    groupCursorModels,
    isNativeAgentProvider,
    parseAntigravityModels,
    parseCodexModels,
} from "../src/providers/native-agents";
import { mapAntigravityTool, mapCodexItem, unwrapShell } from "../src/providers/native-agents/tool-map";

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

describe("codex command line", () => {
    test("a full-access turn reads the prompt from stdin", () => {
        expect(codexArgs({ model: "gpt-5.6-sol", effort: "high", ctx })).toEqual([
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-m",
            "gpt-5.6-sol",
            "-c",
            'model_reasoning_effort="high"',
            "--dangerously-bypass-approvals-and-sandbox",
            "-",
        ]);
    });

    test("a resumed turn names the session before the prompt", () => {
        const args = codexArgs({ model: "m", resumeId: "abc", ctx });
        expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
        expect(args.slice(-2)).toEqual(["abc", "-"]);
    });

    test("plan mode is read-only; asking for approvals is the sandbox", () => {
        expect(codexArgs({ model: "m", ctx: { ...ctx, planMode: true } })).toContain('sandbox_mode="read-only"');
        const approvals = codexArgs({ model: "m", ctx: { ...ctx, approvals: true } });
        expect(approvals).toContain('sandbox_mode="workspace-write"');
        expect(approvals).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    test("a utility call keeps no session", () => {
        const args = codexArgs({ model: "m" });
        expect(args).toContain("--ephemeral");
        expect(args).toContain('sandbox_mode="read-only"');
    });

    test("images are attached as files", () => {
        expect(codexArgs({ model: "m", ctx, images: ["/tmp/a.png"] })).toContain("/tmp/a.png");
    });
});

describe("codex items as loop tools", () => {
    test("a command is bash, without the shell wrapper", () => {
        const mapped = mapCodexItem({
            id: "item_0",
            type: "command_execution",
            command: `/bin/zsh -lc "sed -n '1,20p' note.txt"`,
            aggregated_output: "hello\n",
            exit_code: 0,
            status: "completed",
        });
        expect(mapped).toMatchObject({ name: "bash", input: { command: "sed -n '1,20p' note.txt" }, result: "hello\n", isError: false });
    });

    test("a failing command is an error with its exit code", () => {
        const mapped = mapCodexItem({ type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" });
        expect(mapped.isError).toBe(true);
        expect(mapped.result).toContain("[exit 1]");
    });

    test("one changed file is an edit (or a write when added); several are one patch", () => {
        expect(mapCodexItem({ type: "file_change", changes: [{ path: "/r/a.ts", kind: "update" }], status: "completed" })).toMatchObject({
            name: "edit",
            input: { path: "/r/a.ts" },
        });
        expect(mapCodexItem({ type: "file_change", changes: [{ path: "/r/b.ts", kind: "add" }] }).name).toBe("write");
        expect(
            mapCodexItem({ type: "file_change", changes: [{ path: "a", kind: "add" }, { path: "b", kind: "delete" }] }).name,
        ).toBe("apply_patch");
    });

    test("mcp calls keep the server__tool shape; todos become loop's list", () => {
        expect(mapCodexItem({ type: "mcp_tool_call", server: "gh", tool: "search", arguments: { q: "x" } }).name).toBe("gh__search");
        expect(mapCodexItem({ type: "todo_list", items: [{ text: "a", completed: true }, { text: "b", completed: false }] }).input).toEqual({
            todos: [
                { content: "a", status: "completed" },
                { content: "b", status: "pending" },
            ],
        });
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
