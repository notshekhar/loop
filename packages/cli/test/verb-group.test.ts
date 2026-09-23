import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@notshekhar/loop-core";
import {
    clearToolVerbGroups,
    foldsEagerly,
    foldsWhileRunning,
    kindIdOf,
    registerToolVerbGroup,
    verbGroupLabel,
} from "../src/interactive/ui/verb-group";

afterEach(() => clearToolVerbGroups());

const member = (toolName: string, extra: Partial<{ isError: boolean; isRunning: boolean }> = {}) => ({
    toolName,
    isError: false,
    isRunning: false,
    ...extra,
});

describe("classification", () => {
    test("builtin tools map to their kind", () => {
        expect(kindIdOf("read")).toBe("file");
        expect(kindIdOf("ls")).toBe("dir");
        expect(kindIdOf("grep")).toBe("search");
        expect(kindIdOf("bash")).toBe("command");
        expect(kindIdOf("task")).toBe("subagent");
    });

    test("everything folds except the plan surfaces", () => {
        for (const t of ["read", "ls", "grep", "webfetch", "task", "sql", "bash", "edit", "write", "artifact", "ask"]) {
            expect(foldsEagerly(t)).toBe(true);
        }
        for (const t of ["plan", "enter_plan_mode", "exit_plan_mode"]) expect(foldsEagerly(t)).toBe(false);
    });

    test("only calls that LOOK fold while they are still running", () => {
        // A read folds live — the header counts it as it lands. A command
        // keeps its row until it finishes, because its live output is what
        // you are watching.
        for (const t of ["read", "skill", "ls", "grep", "find", "websearch", "webfetch", "memory", "task", "sql"]) {
            expect(foldsWhileRunning(t)).toBe(true);
        }
        for (const t of ["bash", "shells", "edit", "write", "artifact", "todo", "ask", "linear__x", "frobnicate"]) {
            expect(foldsWhileRunning(t)).toBe(false);
        }
    });
});

describe("loop's own tools are never mistaken for somebody else's", () => {
    // The guard that matters. The fallback rule describes an unrecognised tool
    // by its SOURCE, so a builtin missing from the table does not merely lose
    // its grammar — it claims to be an extension tool, which is a lie the user
    // has no way to see through. `artifact`, `sql`, `ask`, `plan` and
    // `enter_plan_mode` all shipped that way once; this is why they cannot again.
    const BUILTIN_TOOLS = [...AGENT_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME];

    test("every tool loop can emit classifies as one of loop's own kinds", () => {
        for (const name of BUILTIN_TOOLS) {
            const kind = kindIdOf(name);
            expect({ name, kind }).toEqual({ name, kind: expect.not.stringMatching(/^(mcp|extension)$/) });
        }
    });

    test("the artifact tool reads as creating an artifact", () => {
        expect(kindIdOf("artifact")).toBe("artifact");
        expect(verbGroupLabel([member("artifact")]).text).toBe("Created 1 artifact");
        expect(verbGroupLabel([member("artifact"), member("artifact")]).text).toBe("Created 2 artifacts");
    });

    test("the plan surfaces keep their rows", () => {
        // A plan is a document the rest of the turn is judged against, so it
        // is never reduced to a count. An `ask` is not in this set: once
        // answered it is history like any other call, and while it waits it
        // is running — an acting call, which keeps its row until it lands.
        for (const t of ["plan", "enter_plan_mode", "exit_plan_mode"]) expect(foldsEagerly(t)).toBe(false);
        expect(foldsEagerly("ask")).toBe(true);
        expect(foldsWhileRunning("ask")).toBe(false);
    });
});

describe("tools we did not write", () => {
    test("an MCP call is an MCP call, whatever the server named it", () => {
        // The point of the rule: one server's tools all group the same way, so
        // folding is not a lottery on how each one happened to be spelled.
        for (const t of ["sentry__list_errors", "sentry__get_error", "github__frobnicate"]) {
            expect(kindIdOf(t)).toBe("mcp");
            expect(foldsEagerly(t)).toBe(true);
        }
    });

    test("an unregistered extension tool is named by its source, and folds", () => {
        expect(kindIdOf("frobnicate")).toBe("extension");
        expect(kindIdOf("search_issues")).toBe("extension");
        expect(foldsEagerly("frobnicate")).toBe(true);
    });

    test("a name is never evidence of what a tool does", () => {
        // The old heuristic read a leading verb off the name and borrowed the
        // builtin's NOUN with it, so `sentry__list_errors` rendered as "Listed
        // 2 dirs". A verb travels to a third-party tool; the noun does not.
        expect(verbGroupLabel([member("sentry__list_errors"), member("sentry__list_errors")]).text).toBe(
            "Called 2 MCP tools",
        );
        expect(verbGroupLabel([member("confluence__read_page")]).text).toBe("Called 1 MCP tool");
    });

    test("an explicit registration is the way to earn a builtin's grammar", () => {
        registerToolVerbGroup("frobnicate", "web");
        expect(kindIdOf("frobnicate")).toBe("web");
        expect(foldsEagerly("frobnicate")).toBe(true);

        // And it beats the source rule for MCP names too.
        registerToolVerbGroup("github__search_issues", "search");
        expect(kindIdOf("github__search_issues")).toBe("search");

        // Even when it opts a tool OUT of folding — `plan` is the kind that
        // keeps its rows, so an extension whose tool renders a document the
        // user reads against can say so.
        registerToolVerbGroup("dangerous_thing", "plan");
        expect(foldsEagerly("dangerous_thing")).toBe(false);
    });
});

describe("labels", () => {
    test("one segment per kind, in first-seen order", () => {
        const { text } = verbGroupLabel([member("ls"), member("ls"), member("read")]);
        expect(text).toBe("Listed 2 dirs, Read 1 file");
    });

    test("different tools of the same kind merge into one segment", () => {
        expect(verbGroupLabel([member("grep"), member("glob")]).text).toBe("Searched 2 patterns");
    });

    test("nouns agree with their count", () => {
        expect(verbGroupLabel([member("read")]).text).toBe("Read 1 file");
        expect(verbGroupLabel([member("read"), member("read")]).text).toBe("Read 2 files");
    });

    test("a still-running run reads present tense", () => {
        expect(verbGroupLabel([member("read", { isRunning: true })]).text).toBe("Reading 1 file");
        // One running member makes the whole run present tense — the run as a
        // whole is still happening.
        expect(verbGroupLabel([member("read"), member("read", { isRunning: true })]).text).toBe("Reading 2 files");
    });

    test("failures are counted so a fold can't swallow bad news", () => {
        const { text, failed } = verbGroupLabel([member("read"), member("read", { isError: true })]);
        expect(text).toBe("Read 2 files");
        expect(failed).toBe(1);
    });

    test("an unclassified tool still gets a truthful segment", () => {
        expect(verbGroupLabel([member("frobnicate"), member("frobnicate")]).text).toBe("Called 2 extension tools");
    });

    test("MCP and extension calls are separate segments — different sources", () => {
        const { text } = verbGroupLabel([member("github__frobnicate"), member("frobnicate")]);
        expect(text).toBe("Called 1 MCP tool, Called 1 extension tool");
    });
});
