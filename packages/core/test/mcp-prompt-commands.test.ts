/**
 * MCP prompts as slash commands.
 *
 * A prompt is the protocol's "the user starts this, not the model": a
 * server-authored template with named arguments. These tests cover the
 * argument grammar (both `key=value` and positional, mixed), what happens when
 * a required argument is missing, keeping the registry in step with servers
 * that come and go, and the server-driven argument completion.
 */
import { describe, expect, test } from "bun:test";
import { CommandRegistry, type CommandContext } from "../src/commands";
import {
    mcpPromptCommand,
    mcpPromptCommandName,
    parseMcpPromptCommand,
    parsePromptArgs,
    promptArgumentCompletions,
    promptArgumentHint,
    promptCompletionTarget,
    splitArgs,
    syncMcpPromptCommands,
} from "../src/mcp/prompt-commands";
import type { McpPromptEntry } from "../src/mcp/features";

const review: McpPromptEntry = {
    server: "feat",
    name: "review",
    description: "Review a diff",
    arguments: [
        { name: "path", description: "File to review", required: true },
        { name: "tone", description: "blunt or gentle" },
    ],
};

const summarize: McpPromptEntry = { server: "feat", name: "summarize", arguments: [] };

/** A CommandContext that records what the command emitted, and nothing else. */
function recordingContext(): { ctx: CommandContext; events: Array<[string, string]> } {
    const events: Array<[string, string]> = [];
    const ctx = { emit: (event: string, data?: unknown) => events.push([event, String(data ?? "")]) } as CommandContext;
    return { ctx, events };
}

describe("command naming", () => {
    test("a name round-trips through a prompt name containing colons", () => {
        expect(mcpPromptCommandName(review)).toBe("mcp:feat:review");
        expect(parseMcpPromptCommand("mcp:feat:review")).toEqual({ server: "feat", prompt: "review" });
        expect(parseMcpPromptCommand("mcp:feat:ns:deep")).toEqual({ server: "feat", prompt: "ns:deep" });
        expect(parseMcpPromptCommand("help")).toBeUndefined();
    });

    test("the hint marks which arguments are required", () => {
        expect(promptArgumentHint(review)).toBe("<path> [tone]");
        expect(promptArgumentHint(summarize)).toBe("");
    });
});

describe("argument parsing", () => {
    test("quoted values survive splitting", () => {
        expect(splitArgs('a "b c" d')).toEqual(["a", "b c", "d"]);
        expect(splitArgs("  ")).toEqual([]);
        expect(splitArgs('""')).toEqual([""]);
    });

    test("positional arguments fill declared order", () => {
        const parsed = parsePromptArgs("src/app.ts blunt", review.arguments);
        expect(parsed.values).toEqual({ path: "src/app.ts", tone: "blunt" });
        expect(parsed.missing).toEqual([]);
    });

    test("key=value works in any order and beats a positional", () => {
        const parsed = parsePromptArgs("tone=gentle src/app.ts", review.arguments);
        expect(parsed.values).toEqual({ tone: "gentle", path: "src/app.ts" });
    });

    test("an = inside a value stays part of the value", () => {
        const parsed = parsePromptArgs("path=a=b", review.arguments);
        expect(parsed.values.path).toBe("a=b");
    });

    test("an unquoted tail joins the last argument instead of vanishing", () => {
        const parsed = parsePromptArgs("src/app.ts be very blunt indeed", review.arguments);
        expect(parsed.values.path).toBe("src/app.ts");
        expect(parsed.values.tone).toBe("be very blunt indeed");
    });

    test("a key the prompt never declared is reported, not fed in as a value", () => {
        const parsed = parsePromptArgs("path=x style=loud", review.arguments);
        expect(parsed.unknown).toEqual(["style"]);
    });

    test("a missing required argument is named", () => {
        expect(parsePromptArgs("", review.arguments).missing).toEqual(["path"]);
        expect(parsePromptArgs("tone=blunt", review.arguments).missing).toEqual(["path"]);
    });
});

describe("running a prompt command", () => {
    test("the rendered prompt is submitted as a normal turn", async () => {
        const calls: Array<[string, string, Record<string, string>]> = [];
        const command = mcpPromptCommand(review, {
            getPrompt: async (server, prompt, args) => {
                calls.push([server, prompt, args]);
                return "please review src/app.ts";
            },
        });
        const { ctx, events } = recordingContext();
        await command.handler(ctx, "src/app.ts blunt");
        expect(calls).toEqual([["feat", "review", { path: "src/app.ts", tone: "blunt" }]]);
        expect(events).toEqual([["run-prompt", "please review src/app.ts"]]);
    });

    test("a missing required argument shows usage and sends nothing", async () => {
        let fetched = false;
        const command = mcpPromptCommand(review, {
            getPrompt: async () => {
                fetched = true;
                return "x";
            },
        });
        const { ctx, events } = recordingContext();
        await command.handler(ctx, "");
        expect(fetched).toBe(false);
        expect(events[0][0]).toBe("error");
        expect(events[0][1]).toContain("Missing required argument: path");
        expect(events[0][1]).toContain("Usage: /mcp:feat:review <path> [tone]");
    });

    test("a server error is reported, not thrown at the session", async () => {
        const command = mcpPromptCommand(summarize, {
            getPrompt: async () => {
                throw new Error("server exploded");
            },
        });
        const { ctx, events } = recordingContext();
        await command.handler(ctx, "");
        expect(events).toEqual([["error", 'MCP prompt "summarize" failed: server exploded']]);
    });

    test("an empty render is refused rather than submitted as a blank turn", async () => {
        const command = mcpPromptCommand(summarize, { getPrompt: async () => "   " });
        const { ctx, events } = recordingContext();
        await command.handler(ctx, "");
        expect(events[0][1]).toContain("returned nothing to send");
    });
});

describe("registry sync", () => {
    const deps = { getPrompt: async () => "x" };

    test("prompts register, and disappear with their server", () => {
        const reg = new CommandRegistry();
        reg.register({ name: "help", description: "builtin", handler: () => {} });

        expect(syncMcpPromptCommands(reg, [review, summarize], deps)).toBe(true);
        expect(reg.has("mcp:feat:review")).toBe(true);
        expect(reg.has("mcp:feat:summarize")).toBe(true);

        // The server drops off: its commands go with it, or the list fills with
        // commands that can only fail.
        expect(syncMcpPromptCommands(reg, [], deps)).toBe(true);
        expect(reg.has("mcp:feat:review")).toBe(false);
        // Builtins are never touched.
        expect(reg.has("help")).toBe(true);
    });

    test("an unchanged list reports no change, so the menu isn't rebuilt for nothing", () => {
        const reg = new CommandRegistry();
        syncMcpPromptCommands(reg, [review], deps);
        expect(syncMcpPromptCommands(reg, [review], deps)).toBe(false);
    });

    test("a changed argument list replaces the old command", async () => {
        const reg = new CommandRegistry();
        syncMcpPromptCommands(reg, [review], deps);
        // Same name, `path` no longer required.
        const relaxed: McpPromptEntry = { ...review, arguments: [{ name: "path" }] };
        syncMcpPromptCommands(reg, [relaxed], deps);
        const { ctx, events } = recordingContext();
        await reg.get("mcp:feat:review")?.handler(ctx, "");
        // Stale closure would still demand `path` here.
        expect(events[0][0]).toBe("run-prompt");
    });
});

describe("argument completion", () => {
    test("the caret's argument is identified positionally and by key", () => {
        expect(promptCompletionTarget("", review.arguments)).toMatchObject({ argument: "path", partial: "", head: "" });
        expect(promptCompletionTarget("src/", review.arguments)).toMatchObject({ argument: "path", partial: "src/" });
        // First argument complete, caret on the second.
        expect(promptCompletionTarget("src/app.ts ", review.arguments)).toMatchObject({
            argument: "tone",
            partial: "",
            head: "src/app.ts ",
        });
        expect(promptCompletionTarget("tone=bl", review.arguments)).toMatchObject({
            argument: "tone",
            partial: "bl",
            keyed: true,
        });
        expect(promptCompletionTarget("", summarize.arguments)).toBeUndefined();
    });

    test("a completion replaces the whole argument string, keeping what came before", async () => {
        const items = await promptArgumentCompletions(review, "src/app.ts gen", async () => ["gentle"]);
        // Returning just "gentle" here would eat the path.
        expect(items).toEqual([{ value: "src/app.ts gentle", label: "gentle" }]);
    });

    test("a keyed completion stays keyed, and a spaced value is quoted", async () => {
        expect(await promptArgumentCompletions(review, "tone=", async () => ["very blunt"])).toEqual([
            { value: 'tone="very blunt"', label: "very blunt" },
        ]);
    });

    test("the partial value is passed to the server as context", async () => {
        const seen: Array<{ name: string; value: string }> = [];
        await promptArgumentCompletions(review, "src/", async (_server, _ref, argument) => {
            seen.push(argument);
            return [];
        });
        expect(seen).toEqual([{ name: "path", value: "src/" }]);
    });

    test("a prompt with no arguments never asks the server anything", async () => {
        let asked = false;
        const items = await promptArgumentCompletions(summarize, "any", async () => {
            asked = true;
            return ["x"];
        });
        expect(items).toEqual([]);
        expect(asked).toBe(false);
    });
});
