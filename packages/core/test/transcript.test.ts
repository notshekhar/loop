/**
 * loop's transcript protocol (src/transcript): every case here is a bug a
 * client once had rebuilding turns its own way — kept as a pinned shape so no
 * client can have it again.
 */
import { describe, expect, test } from "bun:test";

import {
    applyEvent,
    applyEvents,
    emptyTranscript,
    fromEntries,
    type Transcript,
    type TranscriptEvent,
    type TranscriptPart,
} from "../src/transcript";

const ev = (type: string, data?: unknown): TranscriptEvent => ({ type, data });

/** The parts as a readable outline, dropping live-only timing fields. */
function outline(transcript: Transcript): string[] {
    return transcript.messages.flatMap((message) =>
        message.parts.map((part) => `${message.role}:${describe_(part)}`),
    );
}
function describe_(part: TranscriptPart): string {
    if (part.type === "text") return `text(${part.state}) ${part.text}`;
    if (part.type === "reasoning") return `reasoning(${part.state}) ${part.text}`;
    if (part.type.startsWith("tool-")) {
        const tool = part as Extract<TranscriptPart, { toolCallId: string }>;
        return `${tool.type}#${tool.toolCallId}(${tool.state})`;
    }
    if (part.type === "file") return `file ${part.url}`;
    return `${part.type} ${JSON.stringify((part as { data: unknown }).data)}`;
}

/** What only a live stream knows (timers, raw streaming input) — not part of the agreement. */
function settled(transcript: Transcript): unknown {
    return transcript.messages.map((message) => ({
        id: message.id,
        role: message.role,
        parts: message.parts.map((part) => {
            const { startedAt: _s, inputText: _i, durationMs: _d, ...rest } = part as Record<string, unknown>;
            return rest;
        }),
    }));
}

const interleavedTurn: TranscriptEvent[] = [
    ev("user-message", { id: "u1", text: "check the repo", ts: 1000 }),
    ev("session-running", { running: true }),
    ev("text-delta", "Let me "),
    ev("text-delta", "look."),
    ev("tool-input-start", { toolCallId: "c1", toolName: "bash" }),
    ev("tool-input-delta", { toolCallId: "c1", delta: '{"command":"ls"' }),
    ev("tool-call", { toolCallId: "c1", toolName: "bash", input: { command: "ls" } }),
    ev("tool-result", { toolCallId: "c1", output: "a.ts" }),
    ev("step-usage", { usage: {} }),
    ev("text-delta", "Now the tests."),
    ev("tool-call", { toolCallId: "c2", toolName: "read", input: { path: "a.ts" } }),
    ev("tool-result", { toolCallId: "c2", output: "export {}" }),
    ev("text-delta", "All good."),
    ev("finish", {}),
    ev("session-running", { running: false }),
];

/** The same turn as loop saves it: a user entry, then one assistant entry per step and its tool results. */
const interleavedEntries = [
    { id: "u1", type: "message", role: "user", content: "check the repo", ts: 1000 },
    {
        id: "a1",
        type: "message",
        role: "assistant",
        ts: 1001,
        content: [
            { type: "text", text: "Let me look." },
            { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } },
        ],
    },
    {
        id: "t1",
        type: "message",
        role: "tool",
        ts: 1002,
        content: [{ type: "tool-result", toolCallId: "c1", output: { type: "text", value: "a.ts" } }],
    },
    {
        id: "a2",
        type: "message",
        role: "assistant",
        ts: 1003,
        content: [
            { type: "text", text: "Now the tests." },
            { type: "tool-call", toolCallId: "c2", toolName: "read", input: { path: "a.ts" } },
        ],
    },
    {
        id: "t2",
        type: "message",
        role: "tool",
        ts: 1004,
        content: [{ type: "tool-result", toolCallId: "c2", output: { type: "text", value: "export {}" } }],
    },
    { id: "a3", type: "message", role: "assistant", ts: 1005, content: [{ type: "text", text: "All good." }] },
];

describe("a reply in the order it was written", () => {
    test("text, tool, text, tool, text — not all the text above every tool", () => {
        const transcript = applyEvents(emptyTranscript(), interleavedTurn, 2000);
        expect(outline(transcript)).toEqual([
            "user:text(done) check the repo",
            "assistant:text(done) Let me look.",
            "assistant:tool-bash#c1(output-available)",
            "assistant:text(done) Now the tests.",
            "assistant:tool-read#c2(output-available)",
            "assistant:text(done) All good.",
        ]);
        expect(transcript.running).toBe(false);
    });

    test("one turn is ONE reply message, never split into two turns", () => {
        const transcript = applyEvents(emptyTranscript(), interleavedTurn, 2000);
        expect(transcript.messages.map((message) => `${message.role}:${message.id}`)).toEqual([
            "user:u1",
            "assistant:u1:reply",
        ]);
    });

    test("the saved turn reads exactly as it streamed", () => {
        const live = applyEvents(emptyTranscript(), interleavedTurn, 2000);
        const saved = fromEntries(interleavedEntries);
        expect(settled(saved)).toEqual(settled(live));
    });

    test("mid-turn, the reply so far already reads in order", () => {
        const half = applyEvents(emptyTranscript(), interleavedTurn.slice(0, 10), 2000);
        expect(outline(half)).toEqual([
            "user:text(done) check the repo",
            "assistant:text(done) Let me look.",
            "assistant:tool-bash#c1(output-available)",
            "assistant:text(streaming) Now the tests.",
        ]);
        expect(half.running).toBe(true);
    });
});

describe("thinking", () => {
    test("a thought closes before the text after it, and keeps how long it took", () => {
        const transcript = applyEvents(
            emptyTranscript(),
            [
                ev("user-message", { id: "u1", text: "hi" }),
                ev("reasoning-start"),
                ev("reasoning-delta", "weighing it"),
                ev("reasoning-end"),
                ev("text-delta", "Hello."),
                ev("finish", {}),
            ],
            5000,
        );
        expect(outline(transcript)).toEqual([
            "user:text(done) hi",
            "assistant:reasoning(done) weighing it",
            "assistant:text(done) Hello.",
        ]);
    });

    test("a saved thought keeps its recorded duration", () => {
        const transcript = fromEntries([
            { id: "u1", type: "message", role: "user", content: "hi", ts: 1 },
            {
                id: "a1",
                type: "message",
                role: "assistant",
                ts: 2,
                reasoningMs: [1500],
                content: [
                    { type: "reasoning", text: "hmm" },
                    { type: "text", text: "Hi." },
                ],
            },
        ]);
        const thought = transcript.messages[1]!.parts[0] as { durationMs?: number };
        expect(thought.durationMs).toBe(1500);
    });
});

describe("turn boundaries", () => {
    test("a reply with no turn running starts a new turn instead of welding onto the last", () => {
        // A host older than `user-message` sends no prompt event.
        let transcript = applyEvents(emptyTranscript(), interleavedTurn, 2000);
        transcript = applyEvents(transcript, [ev("text-delta", "Second answer.")], 3000);
        expect(transcript.messages).toHaveLength(3);
        expect(outline(transcript).at(-1)).toBe("assistant:text(streaming) Second answer.");
    });

    test("the recap that trails a turn stays in that turn", () => {
        let transcript = applyEvents(emptyTranscript(), interleavedTurn, 2000);
        transcript = applyEvent(transcript, ev("data-recap", { text: "Checked the repo." }));
        expect(transcript.messages).toHaveLength(2);
        expect(outline(transcript).at(-1)).toBe('assistant:data-recap {"text":"Checked the repo."}');
    });

    test("the same prompt announced twice is one message", () => {
        const transcript = applyEvents(emptyTranscript(), [
            ev("user-message", { id: "u1", text: "hi" }),
            ev("user-message", { id: "u1", text: "hi" }),
        ]);
        expect(transcript.messages).toHaveLength(1);
    });
});

describe("a turn that is stopped", () => {
    test("the call it was in the middle of is marked interrupted, and nothing stays streaming", () => {
        const transcript = applyEvents(emptyTranscript(), [
            ev("user-message", { id: "u1", text: "go" }),
            ev("session-running", { running: true }),
            ev("text-delta", "Running it"),
            ev("tool-call", { toolCallId: "c1", toolName: "bash", input: { command: "sleep 60" } }),
            ev("session-running", { running: false }),
        ]);
        expect(outline(transcript)).toEqual([
            "user:text(done) go",
            "assistant:text(done) Running it",
            "assistant:tool-bash#c1(output-error)",
        ]);
    });

    test("a tool error is an error part, not a missing result", () => {
        const transcript = applyEvents(emptyTranscript(), [
            ev("user-message", { id: "u1", text: "go" }),
            ev("tool-call", { toolCallId: "c1", toolName: "read", input: {} }),
            ev("tool-error", { toolCallId: "c1", toolName: "read", error: new Error("ENOENT") }),
            ev("finish", {}),
        ]);
        const tool = transcript.messages[1]!.parts[0] as { state: string; errorText?: string };
        expect(tool).toMatchObject({ state: "output-error", errorText: "ENOENT" });
    });
});

describe("subagents", () => {
    test("a task's run is drawn inside its own tool part, live", () => {
        const transcript = applyEvents(emptyTranscript(), [
            ev("user-message", { id: "u1", text: "delegate" }),
            ev("tool-call", { toolCallId: "t1", toolName: "task", input: { agent: "explore" } }),
            ev("subagent-delta", { toolCallId: "t1", agent: "explore", text: "Looking" }),
            ev("subagent-delta", { toolCallId: "t1", agent: "explore", text: " around" }),
            ev("subagent-tool", { toolCallId: "t1", agent: "explore", toolName: "grep" }),
            ev("subagent-step-usage", { toolCallId: "t1", agent: "explore", usage: {}, steps: 2, usd: 0.01 }),
            ev("tool-result", { toolCallId: "t1", output: "found it" }),
        ]);
        const task = transcript.messages[1]!.parts[0] as { subagent?: unknown };
        expect(task.subagent).toEqual({
            agent: "explore",
            steps: [
                { type: "text", text: "Looking around" },
                { type: "tool", name: "grep", input: undefined },
            ],
            stepCount: 2,
            usd: 0.01,
            finished: true,
        });
    });

    test("a saved run — written before the step that called it — attaches to its call", () => {
        const transcript = fromEntries([
            { id: "u1", type: "message", role: "user", content: "delegate", ts: 1 },
            {
                id: "s1",
                type: "subagent",
                ts: 2,
                agent: "explore",
                toolCallId: "t1",
                prompt: "look",
                result: "found it",
                activity: [{ type: "text", text: "Looking" }],
                steps: 3,
            },
            {
                id: "a1",
                type: "message",
                role: "assistant",
                ts: 3,
                content: [{ type: "tool-call", toolCallId: "t1", toolName: "task", input: { agent: "explore" } }],
            },
            {
                id: "t1r",
                type: "message",
                role: "tool",
                ts: 4,
                content: [{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "found it" } }],
            },
        ]);
        expect(outline(transcript)).toEqual(["user:text(done) delegate", "assistant:tool-task#t1(output-available)"]);
        expect((transcript.messages[1]!.parts[0] as { subagent?: { stepCount?: number } }).subagent?.stepCount).toBe(3);
    });
});

describe("compaction", () => {
    test("live: a running block that the end fills in", () => {
        const transcript = applyEvents(emptyTranscript(), [
            ev("user-message", { id: "u1", text: "go" }),
            ev("compact-start", { reason: "threshold" }),
            ev("compact-end", { summary: "earlier work", cutAt: 4, tokensBefore: 9000, tokensAfter: 1200 }),
            ev("text-delta", "Continuing."),
            ev("finish", {}),
        ]);
        expect(outline(transcript)).toEqual([
            "user:text(done) go",
            'assistant:data-compaction {"running":false,"reason":"threshold","summary":"earlier work","tokensBefore":9000,"tokensAfter":1200}',
            "assistant:text(done) Continuing.",
        ]);
    });

    test("saved: the marker sits where the cut was, not where the entry was appended", () => {
        const transcript = fromEntries([
            { id: "u1", type: "message", role: "user", content: "one", ts: 1 },
            { id: "a1", type: "message", role: "assistant", ts: 2, content: [{ type: "text", text: "first" }] },
            { id: "u2", type: "message", role: "user", content: "two", ts: 3 },
            { id: "a2", type: "message", role: "assistant", ts: 4, content: [{ type: "text", text: "second" }] },
            { id: "c1", type: "compact", summary: "about one", cutAt: 2, ts: 5, tokensBefore: 100, tokensAfter: 10 },
        ]);
        expect(transcript.messages.map((message) => message.role)).toEqual(["user", "assistant", "system", "user", "assistant"]);
    });
});

describe("rendering stays cheap", () => {
    test("an event changes only the reply it lands in; earlier messages are the same objects", () => {
        const before = applyEvents(emptyTranscript(), interleavedTurn, 2000);
        const after = applyEvents(before, [ev("user-message", { id: "u2", text: "again" }), ev("text-delta", "Sure")]);
        expect(after.messages[0]).toBe(before.messages[0]);
        expect(after.messages[1]).toBe(before.messages[1]);
        // And the input is never edited in place.
        expect(before.messages).toHaveLength(2);
    });

    test("a delta replaces only the part it grows", () => {
        const a = applyEvents(emptyTranscript(), interleavedTurn.slice(0, 10), 2000);
        const b = applyEvent(a, ev("text-delta", " More."));
        const [aParts, bParts] = [a.messages[1]!.parts, b.messages[1]!.parts];
        expect(bParts[0]).toBe(aParts[0]);
        expect(bParts[1]).toBe(aParts[1]);
        expect(bParts[2]).not.toBe(aParts[2]);
    });
});

describe("the checklist", () => {
    test("is the current list, not a history of every write", () => {
        const transcript = applyEvents(emptyTranscript(), [
            ev("todo-update", { items: [{ content: "a", status: "pending" }] }),
            ev("todo-update", { items: [{ content: "a", status: "completed" }] }),
        ]);
        expect(transcript.todos).toEqual([{ content: "a", status: "completed" }]);
        expect(transcript.messages).toHaveLength(0);
    });
});
