import { describe, expect, test } from "bun:test";
import { collectFileLists, compactedContextEntries, findCutPoint } from "../src/agent/compact";
import { Session } from "../src/sessions";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

function fakeSession(entries: Entry[]): Session {
    return new Session(
        { id: "t", createdAt: 0, cwd: "/tmp", provider: "xai", model: "xai/grok-build-0.1" },
        "/tmp/fake.jsonl",
        entries,
    );
}

const msg = (role: "user" | "assistant", content: string): Entry => ({ type: "message", role, content, ts: 0 });
const sub = (agent: string, result: string): Entry => ({ type: "subagent", ts: 0, agent, prompt: "p", result });

describe("compactedContextEntries", () => {
    test("no compact: messages and subagents interleave in order", () => {
        const out = compactedContextEntries(
            fakeSession([msg("user", "a"), sub("plan", "report"), msg("assistant", "b")]),
        );
        expect(out.map((e) => e.kind)).toEqual(["message", "subagent", "message"]);
    });

    test("an active todo list written before the cut is re-injected after the summary", () => {
        const items = [
            { content: "read code", status: "completed" },
            { content: "wire handler", status: "in_progress" },
        ];
        const out = compactedContextEntries(
            fakeSession([
                msg("user", "old-1"),
                { type: "custom", ts: 0, payload: { kind: "todos", items } } as Entry,
                msg("assistant", "old-2"),
                { type: "compact", summary: "SUMMARY", cutAt: 2, ts: 0, tokensBefore: 0, tokensAfter: 0 },
                msg("user", "new-1"),
            ]),
        );
        expect(String((out[0] as { content: unknown }).content)).toContain("SUMMARY");
        const todoMsg = String((out[1] as { content: unknown }).content);
        expect(todoMsg).toContain("todo checklist was active before the compaction");
        expect(todoMsg).toContain("2. [in_progress] wire handler");
        expect(out[2]).toMatchObject({ kind: "message", content: "new-1" });
    });

    test("a post-cut todo write supersedes the pre-cut list — no re-injection", () => {
        const pre = [{ content: "old", status: "in_progress" }];
        const post = [{ content: "new", status: "in_progress" }];
        const out = compactedContextEntries(
            fakeSession([
                { type: "custom", ts: 0, payload: { kind: "todos", items: pre } } as Entry,
                msg("user", "old-1"),
                msg("assistant", "old-2"),
                { type: "compact", summary: "SUMMARY", cutAt: 2, ts: 0, tokensBefore: 0, tokensAfter: 0 },
                msg("user", "new-1"),
                { type: "custom", ts: 0, payload: { kind: "todos", items: post } } as Entry,
            ]),
        );
        expect(out.some((e) => String((e as { content?: unknown }).content ?? "").includes("checklist"))).toBe(false);
    });

    test("an all-terminal pre-cut list is not re-injected", () => {
        const items = [
            { content: "a", status: "completed" },
            { content: "b", status: "cancelled" },
        ];
        const out = compactedContextEntries(
            fakeSession([
                { type: "custom", ts: 0, payload: { kind: "todos", items } } as Entry,
                msg("user", "old-1"),
                msg("assistant", "old-2"),
                { type: "compact", summary: "SUMMARY", cutAt: 2, ts: 0, tokensBefore: 0, tokensAfter: 0 },
                msg("user", "new-1"),
            ]),
        );
        expect(out.some((e) => String((e as { content?: unknown }).content ?? "").includes("checklist"))).toBe(false);
    });

    test("compact cut drops earlier messages and their subagents", () => {
        const out = compactedContextEntries(
            fakeSession([
                msg("user", "old-1"),
                sub("plan", "old-report"),
                msg("assistant", "old-2"),
                { type: "compact", summary: "SUMMARY", cutAt: 2, ts: 0, tokensBefore: 0, tokensAfter: 0 },
                msg("user", "new-1"),
                sub("default", "new-report"),
            ]),
        );
        // summary message + surviving entries
        expect(out[0]).toMatchObject({ kind: "message", role: "user" });
        expect(String((out[0] as { content: unknown }).content)).toContain("SUMMARY");
        const rest = out.slice(1);
        expect(rest).toEqual([
            { kind: "message", role: "user", content: "new-1" },
            { kind: "subagent", agent: "default", result: "new-report" },
        ]);
    });
});

describe("findCutPoint", () => {
    // Each message weighs `tokens` on the chars/4 scale the estimate uses.
    const m = (role: string, tokens: number) => ({ role, content: "x".repeat(tokens * 4) });

    test("keeps the most recent messages up to the token budget", () => {
        const messages = [m("user", 100), m("assistant", 100), m("user", 100), m("assistant", 100)];
        expect(findCutPoint(messages, 0, 200)).toBe(2);
    });

    test("a budget reached mid-message keeps that whole message", () => {
        const messages = [m("user", 100), m("assistant", 100), m("user", 100), m("assistant", 100)];
        expect(findCutPoint(messages, 0, 150)).toBe(2);
    });

    test("may open the window on an assistant message inside a request", () => {
        const messages = [m("user", 10), m("assistant", 500), m("assistant", 100), m("user", 10), m("assistant", 90)];
        expect(findCutPoint(messages, 0, 200)).toBe(2);
    });

    test("walks back over tool results so the window keeps the tool-call pair", () => {
        // 150 tokens back lands on the tool result at index 3 — orphaning it
        // from the assistant tool-call at index 2.
        const messages = [
            m("user", 100),
            m("assistant", 100),
            m("assistant", 100),
            m("tool", 100),
            m("assistant", 100),
        ];
        expect(findCutPoint(messages, 0, 150)).toBe(2);
    });

    test("walks back over consecutive tool messages", () => {
        const messages = [m("user", 10), m("assistant", 10), m("tool", 10), m("tool", 10), m("assistant", 10)];
        expect(findCutPoint(messages, 0, 15)).toBe(1);
    });

    test("never walks below the previous cut", () => {
        const messages = [m("user", 10), m("assistant", 10), m("tool", 10), m("tool", 10), m("assistant", 10)];
        expect(findCutPoint(messages, 3, 15)).toBe(3);
    });

    test("keeps everything when the history is under budget", () => {
        expect(findCutPoint([m("user", 10), m("assistant", 10)], 0, 20_000)).toBe(0);
    });

    test("a zero budget keeps nothing", () => {
        expect(findCutPoint([m("user", 10), m("assistant", 10)], 0, 0)).toBe(2);
    });
});

describe("collectFileLists", () => {
    const call = (toolName: string, path: string) => ({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c", toolName, input: { path } }],
    });

    test("files read and changed come from the tool calls; a changed file is not also listed as read", () => {
        const files = collectFileLists([
            call("read", "src/a.ts"),
            call("read", "src/b.ts"),
            call("edit", "src/b.ts"),
            call("write", "src/c.ts"),
            call("read", "loop://docs"),
        ]);
        expect(files).toEqual({ readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts", "src/c.ts"] });
    });

    test("carries the previous compaction's lists forward", () => {
        const files = collectFileLists([call("read", "src/new.ts")], {
            readFiles: ["src/old.ts"],
            modifiedFiles: ["src/changed.ts"],
        });
        expect(files).toEqual({ readFiles: ["src/new.ts", "src/old.ts"], modifiedFiles: ["src/changed.ts"] });
    });
});
