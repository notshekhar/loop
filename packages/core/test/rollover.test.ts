import { describe, expect, test } from "bun:test";
import { buildRolloverHandoff, MIN_USABLE_TOKENS } from "../src/agent/rollover";
import { compactionBlockText, compactionBodyText, ROLLOVER_PREAMBLE } from "../src/agent/compact";
import { adaptSessionEntry } from "../src/sessions/session-adapter";
import { TODOS_KIND } from "../src/tools/todo";
import type { Entry } from "../src/types";

const userMsg = (id: string, text: string, parentId: string | null = null): Entry =>
    ({ type: "message", role: "user", content: text, ts: 1, id, parentId }) as Entry;

const assistantCall = (id: string, toolName: string, input: unknown, parentId: string): Entry =>
    ({
        type: "message",
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: `${id}-c`, toolName, input }],
        ts: 2,
        id,
        parentId,
    }) as Entry;

describe("buildRolloverHandoff", () => {
    test("keeps every user message verbatim — owner intent is never inferable again", () => {
        const branch = [userMsg("u1", "build the parser"), userMsg("u2", "do NOT use regex", "u1")];
        const out = buildRolloverHandoff(branch, { limit: 20_000})!;
        expect(out).toContain("build the parser");
        expect(out).toContain("do NOT use regex");
    });

    test("carries the todo list, files touched and commands run", () => {
        const branch: Entry[] = [
            userMsg("u1", "fix the tests"),
            assistantCall("a1", "edit", { file_path: "/repo/src/parse.ts" }, "u1"),
            assistantCall("a2", "bash", { command: "bun test packages/core" }, "a1"),
            {
                type: "custom",
                ts: 3,
                id: "c1",
                parentId: "a2",
                payload: { kind: TODOS_KIND, items: [{ content: "make it green", status: "in_progress" }] },
            } as Entry,
        ];
        const out = buildRolloverHandoff(branch, { limit: 20_000 })!;
        expect(out).toContain("/repo/src/parse.ts");
        expect(out).toContain("bun test packages/core");
        expect(out).toContain("make it green");
    });

    test("carryCommands: false drops the command list but keeps the files", () => {
        const branch: Entry[] = [
            userMsg("u1", "go"),
            assistantCall("a1", "bash", { command: "rm -rf build" }, "u1"),
            assistantCall("a2", "write", { file_path: "/repo/x.ts" }, "a1"),
        ];
        const out = buildRolloverHandoff(branch, { limit: 20_000, carryCommands: false })!;
        expect(out).not.toContain("rm -rf build");
        expect(out).toContain("/repo/x.ts");
    });

    /**
     * The regression that decides whether rollover keeps working over a long
     * session: pre-cut entries stay on the branch, so a builder that scans from
     * the root re-collects all of history on every subsequent boundary.
     */
    test("scans from the last boundary, so successive handoffs do not grow", () => {
        const older = Array.from({ length: 12 }, (_, i) => userMsg(`old${i}`, `ancient request number ${i}`));
        const boundary: Entry = {
            type: "compact",
            ts: 5,
            summary: "",
            handoff: "prior record",
            rollover: true,
            cutAt: 12,
            tokensBefore: 100,
            tokensAfter: 10,
            id: "b1",
            parentId: "old11",
        } as Entry;
        const fresh = userMsg("n1", "the only current request", "b1");

        const first = buildRolloverHandoff(older, { limit: 20_000 })!;
        const second = buildRolloverHandoff([...older, boundary, fresh], { limit: 20_000 })!;

        expect(second).toContain("the only current request");
        expect(second).not.toContain("ancient request number 0");
        expect(second.length).toBeLessThan(first.length);
    });

    test("never nests a prior rollover record", () => {
        const branch: Entry[] = [
            {
                type: "compact",
                ts: 5,
                summary: "",
                handoff: "SECRET_PRIOR_RECORD_BODY",
                rollover: true,
                cutAt: 0,
                tokensBefore: 1,
                tokensAfter: 1,
                id: "b1",
                parentId: null,
            } as Entry,
            userMsg("u1", "carry on", "b1"),
        ];
        const out = buildRolloverHandoff(branch, { limit: 20_000 })!;
        expect(out).toContain("carry on");
        expect(out).not.toContain("SECRET_PRIOR_RECORD_BODY");
    });

    test("returns undefined when nothing fits, so the caller can fall back", () => {
        expect(buildRolloverHandoff([userMsg("u1", "hello")], { limit: 10 })).toBeUndefined();
        expect(buildRolloverHandoff([], { limit: 20_000 })).toBeUndefined();
    });

    test("MIN_USABLE_TOKENS leaves a handoff plus equal working room", () => {
        expect(MIN_USABLE_TOKENS).toBe(10_000);
    });
});

describe("the rollover block", () => {
    test("a handoff replaces the summary block entirely", () => {
        const block = compactionBlockText({ summary: "", handoff: "RECORD" });
        expect(block).toContain(ROLLOVER_PREAMBLE);
        expect(block).toContain("RECORD");
        expect(block).not.toContain("compacted into the following summary");
    });

    test("without a handoff the summary block is unchanged", () => {
        const block = compactionBlockText({ summary: "OLD SUMMARY" });
        expect(block).toContain("compacted into the following summary");
        expect(block).toContain("OLD SUMMARY");
    });

    test("body text prefers the handoff", () => {
        expect(compactionBodyText({ summary: "", handoff: "H" })).toBe("H");
        expect(compactionBodyText({ summary: "S" })).toBe("S");
    });
});

/**
 * Session.load() rebuilds every stored entry through adaptSessionEntry, which
 * is an explicit allowlist. A field missing from it is dropped on reload — and
 * a rollover's whole context lives in that field, so this is the test that
 * catches an otherwise invisible break: it works live, then resume opens on an
 * empty summary block.
 */
describe("rollover survives the store round-trip", () => {
    test("adaptSessionEntry preserves handoff and rollover", () => {
        const stored = {
            type: "compact",
            ts: 7,
            summary: "",
            handoff: "THE RECOVERY RECORD",
            rollover: true,
            cutAt: 12,
            tokensBefore: 21_388,
            tokensAfter: 900,
            id: "c1",
            parentId: "a1",
        };
        const back = adaptSessionEntry(JSON.parse(JSON.stringify(stored))) as Extract<Entry, { type: "compact" }>;
        expect(back.handoff).toBe("THE RECOVERY RECORD");
        expect(back.rollover).toBe(true);
        expect(back.cutAt).toBe(12);
    });

    test("a summarizing compaction still round-trips without them", () => {
        const back = adaptSessionEntry({
            type: "compact",
            ts: 7,
            summary: "S",
            cutAt: 4,
            tokensBefore: 10,
            tokensAfter: 2,
            id: "c1",
            parentId: null,
        }) as Extract<Entry, { type: "compact" }>;
        expect(back.summary).toBe("S");
        expect(back.handoff).toBeUndefined();
        expect(back.rollover).toBeUndefined();
    });
});

describe("the tool batch no model has read yet", () => {
    test("carries the results' output, not an empty string", () => {
        const branch: Entry[] = [
            userMsg("u1", "run the tests"),
            assistantCall("a1", "bash", { command: "bun test" }, "u1"),
            {
                type: "message",
                role: "tool",
                ts: 3,
                id: "t1",
                parentId: "a1",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "a1-c",
                        toolName: "bash",
                        output: { type: "text", value: "3 pass\n1 fail: parser rejects empty input" },
                    },
                ],
            } as Entry,
        ];
        const out = buildRolloverHandoff(branch, { limit: 20_000 })!;
        expect(out).toContain("parser rejects empty input");
    });
});
