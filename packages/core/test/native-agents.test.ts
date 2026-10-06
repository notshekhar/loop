import { describe, expect, test } from "bun:test";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import {
    claudeReasoningOptions,
    groupCursorModels,
    parseCursorVariant,
    selectCursorVariant,
} from "../src/providers/native-agents";
import { flattenNativeAgentParts, hasNativeAgentParts } from "../src/providers/native-agents/history";
import { nearestEffort, PartWriter, planPrompt } from "../src/providers/native-agents/shared";
import { mapClaudeTool, mapCursorTool } from "../src/providers/native-agents/tool-map";

describe("cursor variant parsing", () => {
    const cases: Array<[string, string, string, boolean]> = [
        // id, family, effort, thinking
        ["gpt-5.3-codex-low-fast", "gpt-5.3-codex-fast", "low", false],
        ["gpt-5.3-codex", "gpt-5.3-codex", "default", false],
        ["claude-opus-5-thinking-high", "claude-opus-5", "high", true],
        ["claude-opus-5-high", "claude-opus-5", "high", false],
        ["claude-opus-4-8-thinking-max-fast", "claude-opus-4-8-fast", "max", true],
        ["claude-4.6-sonnet-medium-thinking", "claude-4.6-sonnet", "medium", true],
        ["claude-4.5-sonnet-thinking", "claude-4.5-sonnet", "default", true],
        ["gpt-5.5-extra-high", "gpt-5.5", "xhigh", false],
        ["claude-opus-5-5-low", "claude-opus-5-5", "low", false],
        ["muse-spark-1.3-minimal", "muse-spark-1.3", "minimal", false],
        ["gpt-5.2-fast", "gpt-5.2-fast", "default", false],
        ["auto", "auto", "default", false],
        ["kimi-k2.7-code", "kimi-k2.7-code", "default", false],
    ];
    for (const [id, family, effort, thinking] of cases) {
        test(id, () => {
            const { familyId, variant } = parseCursorVariant(id, id);
            expect(familyId).toBe(family);
            expect(variant.effort).toBe(effort as never);
            expect(variant.thinking).toBe(thinking);
        });
    }
});

describe("cursor variant selection", () => {
    const [opus] = groupCursorModels(
        [
            "claude-opus-4-8-low",
            "claude-opus-4-8-medium",
            "claude-opus-4-8-high",
            "claude-opus-4-8-thinking-low",
            "claude-opus-4-8-thinking-high",
            "claude-opus-4-8-thinking-max",
        ].map((id) => ({ id, name: "Claude Opus 4.8 High Thinking" })),
    );
    const [gpt] = groupCursorModels(
        ["gpt-5.6-sol-none", "gpt-5.6-sol-low", "gpt-5.6-sol-high", "gpt-5.6-sol-max"].map((id) => ({ id, name: id })),
    );

    test("family name drops effort words", () => expect(opus.name).toBe("Claude Opus 4.8"));
    test("thinking on picks a thinking variant", () =>
        expect(selectCursorVariant(opus, "high").id).toBe("claude-opus-4-8-thinking-high"));
    test("nearest effort, stronger on a tie", () =>
        expect(selectCursorVariant(opus, "medium").id).toBe("claude-opus-4-8-thinking-high"));
    test("xhigh rounds to max when that is what exists", () =>
        expect(selectCursorVariant(opus, "xhigh").id).toBe("claude-opus-4-8-thinking-max"));
    test("thinking off picks a non-thinking variant", () =>
        expect(selectCursorVariant(opus, "none").id).toBe("claude-opus-4-8-low"));
    test("off maps to a none effort when the family has one", () =>
        expect(selectCursorVariant(gpt, "none").id).toBe("gpt-5.6-sol-none"));
    test("single-variant families always use that variant", () => {
        const [auto] = groupCursorModels([{ id: "auto", name: "Auto" }]);
        expect(selectCursorVariant(auto, "high").id).toBe("auto");
        expect(auto.reasoning).toBe(false);
    });
});

describe("claude reasoning options", () => {
    const opus = {
        value: "opus",
        displayName: "Opus",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] as never,
        supportsAdaptiveThinking: true,
    };
    const haiku = { value: "haiku", displayName: "Haiku", description: "" };

    test("no level → CLI defaults", () => expect(claudeReasoningOptions(opus, undefined)).toEqual({}));
    test("off disables thinking", () => expect(claudeReasoningOptions(opus, "none")).toEqual({ thinking: { type: "disabled" } }));
    test("adaptive model takes effort", () =>
        expect(claudeReasoningOptions(opus, "high")).toEqual({
            thinking: { type: "adaptive", display: "summarized" },
            effort: "high",
        }));
    test("minimal floors at low", () => expect(claudeReasoningOptions(opus, "minimal").effort).toBe("low"));
    test("pre-adaptive model gets a budget, no effort", () =>
        expect(claudeReasoningOptions({ ...haiku, supportsAdaptiveThinking: false }, "medium")).toEqual({
            thinking: { type: "enabled", budgetTokens: 8_192, display: "summarized" },
        }));
});

describe("prompt planning", () => {
    const user = (text: string): LanguageModelV4Message => ({ role: "user", content: [{ type: "text", text }] });
    const assistant = (text: string): LanguageModelV4Message => ({ role: "assistant", content: [{ type: "text", text }] });
    const link = (seen: number) => ({ nativeId: "native-1", seen, model: "sonnet", updatedAt: 0 });

    test("first turn sends the message alone", () => {
        const plan = planPrompt([{ role: "system", content: "sys" }, user("hi")], undefined, "sonnet");
        expect(plan).toMatchObject({ text: "hi", seen: 1 });
        expect(plan.resumeId).toBeUndefined();
    });
    test("resumes when only its own reply came in between", () => {
        const plan = planPrompt([user("hi"), assistant("hello"), user("next")], link(1), "sonnet");
        expect(plan).toMatchObject({ resumeId: "native-1", text: "next", seen: 3 });
    });
    test("re-seeds when another model answered in between", () => {
        const prompt = [user("hi"), assistant("a"), user("q2"), assistant("b"), user("q3")];
        const plan = planPrompt(prompt, link(1), "sonnet");
        expect(plan.resumeId).toBeUndefined();
        expect(plan.text).toContain("<conversation-so-far>");
        expect(plan.text).toEndWith("q3");
    });
    test("re-seeds after a model switch within the provider", () => {
        expect(planPrompt([user("hi"), assistant("a"), user("q")], link(1), "opus").resumeId).toBeUndefined();
    });
    test("re-seeds when history shrank (compaction)", () => {
        expect(planPrompt([user("summary"), user("q")], link(5), "sonnet").resumeId).toBeUndefined();
    });
});

test("nearestEffort", () => {
    expect(nearestEffort("xhigh", ["low", "high"])).toBe("high");
    expect(nearestEffort("medium", ["low", "high"])).toBe("high");
    expect(nearestEffort("none", ["low", "medium"])).toBe("low");
    expect(nearestEffort("high", [])).toBeUndefined();
});

describe("tool mapping onto loop's vocabulary", () => {
    test("claude Read/Edit/Glob/mcp", () => {
        expect(mapClaudeTool("Read", { file_path: "a.ts", offset: 3 })).toEqual({ name: "read", input: { path: "a.ts", offset: 3 } });
        expect(mapClaudeTool("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" })).toEqual({
            name: "edit",
            input: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
        });
        expect(mapClaudeTool("Glob", { pattern: "*.ts" }).name).toBe("find");
        expect(mapClaudeTool("mcp__github__list_issues", { repo: "r" })).toEqual({ name: "github__list_issues", input: { repo: "r" } });
        expect(mapClaudeTool("SomethingNew", { a: 1 })).toEqual({ name: "SomethingNew", input: { a: 1 } });
    });
    test("cursor shell/read/write", () => {
        expect(mapCursorTool("shell", { command: "ls" })).toEqual({ name: "bash", input: { command: "ls" } });
        expect(mapCursorTool("read", { path: "n.txt" })).toEqual({ name: "read", input: { path: "n.txt" } });
        expect(mapCursorTool("write", { path: "n.txt", fileText: "hi" })).toEqual({ name: "write", input: { path: "n.txt", content: "hi" } });
    });
});

describe("history for other models", () => {
    const tag = { nativeAgent: { provider: "claude-code" } };
    const content = [
        { type: "text", text: "Reading." },
        { type: "tool-call", toolCallId: "1", toolName: "read", input: { path: "n.txt" }, providerExecuted: true, providerOptions: tag },
        { type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "banana" }, providerOptions: tag },
        { type: "text", text: "It is banana." },
    ];
    test("native tool parts become text; others untouched", () => {
        expect(hasNativeAgentParts(content)).toBe(true);
        const flat = flattenNativeAgentParts(content) as Array<{ type: string; text: string }>;
        expect(flat.every((p) => p.type === "text")).toBe(true);
        expect(flat[1].text).toBe('[Claude Code ran read: {"path":"n.txt"}]');
        expect(flat[2].text).toBe("[read result]\nbanana");
        expect(hasNativeAgentParts([{ type: "tool-call", toolName: "bash" }])).toBe(false);
    });
});

test("text segments around a tool call are separated", () => {
    const parts: Array<{ type: string; delta?: string }> = [];
    const w = new PartWriter((p) => parts.push(p as never), "claude-code");
    w.text("Reading the file.");
    w.toolCall("1", "read", {});
    w.text("Done.");
    w.endAll();
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta)).toEqual(["Reading the file.", "\n\nDone."]);
});
