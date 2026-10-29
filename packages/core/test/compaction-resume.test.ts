/**
 * A compaction has to survive what happens to a session after it: closing and
 * resuming (a fresh Session read back from the database), /tree navigation to
 * either side of it, more compactions on top — and the summarizer itself has
 * to survive a dropped stream instead of failing the whole compaction.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Session } from "../src/sessions";
import type { Entry } from "../src/types";
import { useTempSessionDb } from "./helpers/temp-db";

useTempSessionDb();

// Delegating mock (see stream-resume.test.ts): bun module mocks leak across
// files, so getModel is only faked while a test has set currentModel.
let currentModel: MockLanguageModelV3 | null = null;
const realProviders = await import("../src/providers");
mock.module("../src/providers", () => ({
    ...realProviders,
    getModel: async (...args: Parameters<typeof realProviders.getModel>) =>
        currentModel ?? realProviders.getModel(...args),
}));

const MODEL = "xai/grok-build-0.1";

afterEach(() => {
    currentModel = null;
});

const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function streamOf(parts: Array<Record<string, unknown>>) {
    return {
        stream: new ReadableStream({
            start(c) {
                for (const p of parts) c.enqueue(p);
                c.close();
            },
        }),
    };
}

const reply = (text: string) =>
    streamOf([
        { type: "text-start", id: "s" },
        { type: "text-delta", id: "s", delta: text },
        { type: "text-end", id: "s" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]);

/** Summaries numbered in request order: SUMMARY-1, SUMMARY-2, … */
function numberedSummaries() {
    let n = 0;
    return new MockLanguageModelV3({ doStream: async () => reply(`SUMMARY-${++n}`) });
}

function mk(): Session {
    const dir = mkdtempSync(join(tmpdir(), "loop-compact-resume-"));
    return new Session(
        { id: `s-${Math.random().toString(36).slice(2)}`, createdAt: 0, cwd: dir, provider: "xai", model: MODEL },
        join(dir, "s.jsonl"),
        [],
    );
}

const msg = (role: "user" | "assistant", content: string): Entry => ({ type: "message", role, content, ts: 0 });

/** ~6k-token requests with short answers, so a 20k kept window cuts on a user message. */
async function chat(s: Session, from: number, count: number): Promise<void> {
    for (let i = from; i < from + count; i++) {
        await s.append(msg("user", `request ${i} ${"x".repeat(24_000)}`));
        await s.append(msg("assistant", `answer ${i}`));
    }
}

/** What the model would be sent, as comparable text. */
async function contextOf(s: Session): Promise<string[]> {
    const { compactedContextEntries } = await import("../src/agent/compact");
    return compactedContextEntries(s).map((e) => {
        if (e.kind !== "message") return `subagent:${e.agent}`;
        const text = String(e.content);
        const summary = text.split("<summary>\n")[1];
        return summary ? `summary:${summary.slice(0, 40)}` : `${e.role}:${text.split(" xx")[0]}`;
    });
}

const reload = (s: Session) => Session.load(s.path, s.info);

describe("a compacted session resumed after closing", () => {
    test("reads back the same context it had before it closed", async () => {
        currentModel = numberedSummaries();
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 0, 8);
        const result = await runCompact({ session: s, modelId: MODEL });
        expect(result.cutAt).toBeGreaterThan(0);

        const before = await contextOf(s);
        expect(before[0]).toStartWith("summary:");
        expect(before.some((l) => l.includes("request 0"))).toBe(false);

        const resumed = reload(s);
        expect(await contextOf(resumed)).toEqual(before);
        expect(resumed.lastCompactCutAt()).toBe(result.cutAt);
    });

    test("keeps going after a resume: new messages, then a second compaction folds into the first", async () => {
        currentModel = numberedSummaries();
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 0, 8);
        await runCompact({ session: s, modelId: MODEL });

        const resumed = reload(s);
        await chat(resumed, 8, 8);
        const second = await runCompact({ session: resumed, modelId: MODEL });
        expect(second.summary).toStartWith("SUMMARY-2");
        const prompt = JSON.stringify(currentModel.doStreamCalls[1].prompt);
        expect(prompt).toContain("<previous-summary>\\nSUMMARY-1");

        const again = reload(resumed);
        expect(await contextOf(again)).toEqual(await contextOf(resumed));
        expect((await contextOf(again))[0]).toStartWith("summary:SUMMARY-2");
    });
});

describe("/tree around a compaction", () => {
    test("going back to before it drops the summary; coming back restores it — across a resume too", async () => {
        currentModel = numberedSummaries();
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 0, 8);
        const early = s.getBranch()[3].id!; // the answer to request 1
        await runCompact({ session: s, modelId: MODEL });
        await s.append(msg("user", "after the compaction"));
        const compactedLeaf = s.getLeafId()!;

        s.branch(early);
        const old = await contextOf(s);
        expect(old.some((l) => l.startsWith("summary:"))).toBe(false);
        expect(old).toEqual(["user:request 0", "assistant:answer 0", "user:request 1", "assistant:answer 1"]);

        // Work on the old branch persists and resumes onto that branch.
        await s.append(msg("user", "a different direction"));
        const resumed = reload(s);
        const branchContext = await contextOf(resumed);
        expect(branchContext.at(-1)).toBe("user:a different direction");
        expect(branchContext.some((l) => l.startsWith("summary:"))).toBe(false);

        resumed.branch(compactedLeaf);
        const back = await contextOf(resumed);
        expect(back[0]).toStartWith("summary:");
        expect(back.at(-1)).toBe("user:after the compaction");
    });

    test("the compaction hangs off the leaf it was made at: older messages see the whole history (pi's tree)", async () => {
        currentModel = numberedSummaries();
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 0, 8);
        const result = await runCompact({ session: s, modelId: MODEL });
        await s.append(msg("user", "first after"));
        const firstAfter = s.getLeafId()!;
        await s.append(msg("assistant", "reply after"));

        // A message kept word for word, but older than the compaction entry.
        const keptMessage = s.getBranch().filter((e) => e.type === "message")[result.cutAt].id!;
        s.branch(keptMessage);
        expect((await contextOf(s))[0]).toBe("user:request 0");

        // A message newer than the compaction: the summary and the cut still apply.
        s.branch(firstAfter);
        await s.append(msg("assistant", "another answer"));
        const ctx = await contextOf(reload(s));
        expect(ctx[0]).toStartWith("summary:");
        expect(ctx.at(-1)).toBe("assistant:another answer");
        expect(ctx.filter((l) => l.startsWith("user:request"))).toHaveLength(8 - result.cutAt / 2);
    });

    test("a compaction made on a branch summarizes that branch only", async () => {
        currentModel = numberedSummaries();
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 0, 2);
        const fork = s.getLeafId()!;
        await s.append(msg("user", "ABANDONED PATH"));
        s.branch(fork);
        await chat(s, 2, 6);
        await runCompact({ session: s, modelId: MODEL });
        const prompt = JSON.stringify(currentModel.doStreamCalls[0].prompt);
        expect(prompt).not.toContain("ABANDONED PATH");
        expect(prompt).toContain('"text":"request 0 ');
        expect((await contextOf(reload(s))).some((l) => l.includes("ABANDONED"))).toBe(false);
    });
});

describe("the summarizer request", () => {
    test("a dropped stream or an overloaded provider is tried again", async () => {
        let calls = 0;
        currentModel = new MockLanguageModelV3({
            doStream: async () => {
                calls++;
                if (calls === 1) throw new Error("socket hang up");
                if (calls === 2)
                    throw new APICallError({
                        message: "overloaded",
                        url: "x",
                        requestBodyValues: {},
                        statusCode: 529,
                        isRetryable: true,
                    });
                return reply("RECOVERED");
            },
        });
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 0, 8);
        const result = await runCompact({ session: s, modelId: MODEL });
        expect(result.summary).toStartWith("RECOVERED");
        expect(calls).toBeGreaterThanOrEqual(3);
    }, 30_000);

    test("streams the request on the session's model, with its output cap", async () => {
        currentModel = numberedSummaries();
        const { runCompact } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 0, 8);
        await runCompact({ session: s, modelId: MODEL });
        expect(currentModel.doStreamCalls.length).toBeGreaterThan(0);
        expect(currentModel.doGenerateCalls).toHaveLength(0);
        expect(currentModel.doStreamCalls[0].maxOutputTokens).toBeGreaterThan(0);
    });

    test("an abort stops it and saves nothing", async () => {
        const abort = new AbortController();
        currentModel = new MockLanguageModelV3({
            doStream: async () => {
                abort.abort();
                throw Object.assign(new Error("aborted"), { name: "AbortError" });
            },
        });
        const { runCompact, CompactAbortedError } = await import("../src/agent/compact");
        const s = mk();
        await chat(s, 0, 8);
        await expect(runCompact({ session: s, modelId: MODEL, abortSignal: abort.signal })).rejects.toBeInstanceOf(
            CompactAbortedError,
        );
        expect(
            reload(s)
                .entries()
                .some((e) => e.type === "compact"),
        ).toBe(false);
    });
});
