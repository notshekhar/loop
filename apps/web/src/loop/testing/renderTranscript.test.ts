/**
 * What a turn actually looks like, end to end.
 *
 * These drive loop's own wire shapes through the whole pipeline — events into
 * the live turn, history into the thread, thread into timeline rows — and
 * assert the sequence of blocks. Ordering is the thing they exist for: it is
 * the one property no single layer's test can show, because it only goes wrong
 * where the three arrays the contract demands get merged back together.
 */
import { describe, expect, it } from "vite-plus/test";

import { derivePendingUserInputs } from "../../session-logic";
import { renderTranscript, type LoopEventPart } from "./renderTranscript.ts";

// History and live overlapping (the same call, run, recap or checklist in
// both) cannot happen any more: the transcript store applies only events
// after the host snapshot's seq, and the host builds that snapshot from one
// stream — see packages/core/test/transcript.test.ts ("the saved turn reads
// exactly as it streamed") and src/loop/transcript/store.ts.

const CWD = "/w/project";
const userEntry = (text: string, ts = 1_700_000_001_000, id = "u1") => ({
  type: "message",
  role: "user",
  content: text,
  ts,
  id,
});

const assistant = (content: unknown[], ts = 1_700_000_002_000, id = "a1") => ({
  type: "message",
  role: "assistant",
  content,
  ts,
  id,
});

const toolResult = (toolCallId: string, value: string, ts = 1_700_000_003_000, id = "t1") => ({
  type: "message",
  role: "tool",
  content: [{ type: "tool-result", toolCallId, output: { type: "text", value } }],
  ts,
  id,
});

describe("a replayed turn", () => {
  it("keeps text, tool, text in the order the model wrote them", async () => {
    // The bug this pins: loop stamps every part of one assistant message with
    // the same `ts`, and the timeline sorts on that alone — so concatenating
    // the text into one message put the whole reply above (or below) every
    // call it made, no matter what actually happened.
    const view = await renderTranscript({
      history: [
        userEntry("do the thing"),
        assistant([
          { type: "text", text: "STARTING" },
          { type: "tool-call", toolName: "bash", toolCallId: "c1", input: { command: "wc -l a" } },
          { type: "text", text: "MIDDLE" },
          { type: "tool-call", toolName: "read", toolCallId: "c2", input: { path: `${CWD}/a.ts` } },
          { type: "text", text: "FINISHED" },
        ]),
        toolResult("c1", "3\n"),
      ],
    });

    expect(view.shape).toEqual([
      "user do the thing",
      "assistant STARTING",
      "tool bash wc -l a",
      "assistant MIDDLE",
      "tool read a.ts",
      "assistant FINISHED",
    ]);
  });

  it("puts thinking before the tool it led to", async () => {
    const view = await renderTranscript({
      history: [
        userEntry("think then act"),
        assistant([
          { type: "reasoning", text: "I should look at the file." },
          { type: "tool-call", toolName: "read", toolCallId: "c1", input: { path: `${CWD}/a.ts` } },
          { type: "text", text: "Read it." },
        ]),
      ],
    });

    expect(view.shape).toEqual([
      "user think then act",
      "thinking Thought",
      "tool read a.ts",
      "assistant Read it.",
    ]);
  });

  it("renders a read's range and a failure's state", async () => {
    const view = await renderTranscript({
      history: [
        userEntry("read a slice"),
        assistant([
          {
            type: "tool-call",
            toolName: "read",
            toolCallId: "c1",
            input: { path: `${CWD}/src/app.ts`, offset: 120, limit: 61 },
          },
          { type: "tool-call", toolName: "bash", toolCallId: "c2", input: { command: "false" } },
        ]),
        toolResult("c1", "one\ntwo"),
        {
          type: "message",
          role: "tool",
          id: "t2",
          ts: 1_700_000_004_000,
          content: [
            {
              type: "tool-result",
              toolCallId: "c2",
              output: { type: "error-text", value: "exit 1" },
            },
          ],
        },
      ],
    });

    const tools = view.blocks.filter((block) => block.kind === "tool");
    expect(tools[0]?.tool).toMatchObject({
      name: "read",
      summary: "src/app.ts:120-180",
      state: "success",
      output: "one\ntwo",
    });
    expect(tools[1]?.tool).toMatchObject({ name: "bash", state: "error", output: "exit 1" });
  });

  it("shows a recap as its own block, not another reply", async () => {
    const view = await renderTranscript({
      history: [
        userEntry("change it"),
        assistant([{ type: "text", text: "Done." }]),
        {
          type: "custom",
          ts: 1_700_000_005_000,
          id: "c1",
          payload: { kind: "recap", text: "Renamed the flag." },
        },
      ],
    });

    expect(view.shape).toEqual(["user change it", "assistant Done.", "recap Renamed the flag."]);
  });

  it("renders loop's plan tool as a plan block", async () => {
    const view = await renderTranscript({
      history: [
        userEntry("plan it"),
        assistant([
          {
            type: "tool-call",
            toolName: "plan",
            toolCallId: "c1",
            input: { plan: "# Ship it\n\n1. Do the thing" },
          },
        ]),
      ],
    });

    expect(view.shape).toEqual(["user plan it", "plan # Ship it"]);
  });
});

describe("a turn in flight", () => {
  const streaming = (parts: LoopEventPart[]) =>
    renderTranscript({ history: [userEntry("go")], events: parts, running: true });

  it("interleaves live text and tools as they arrive", async () => {
    const view = await streaming([
      { type: "text-delta", data: "STARTING" },
      { type: "tool-input-start", data: { toolCallId: "c1", toolName: "bash" } },
      { type: "tool-call", data: { toolCallId: "c1", toolName: "bash", input: { command: "ls" } } },
      { type: "tool-result", data: { toolCallId: "c1", output: "a\nb" } },
      { type: "text-delta", data: "FINISHED" },
    ]);

    expect(view.shape).toEqual([
      "user go",
      "assistant STARTING",
      "tool bash ls",
      "assistant FINISHED",
    ]);
  });

  it("shows a thinking block streaming, then timed once it closes", async () => {
    const live = await streaming([
      { type: "reasoning-start", data: undefined },
      { type: "reasoning-delta", data: "weighing it up" },
    ]);
    expect(live.blocks.find((block) => block.kind === "thinking")?.thinking).toMatchObject({
      text: "weighing it up",
      streaming: true,
    });

    const closed = await streaming([
      { type: "reasoning-delta", data: "weighing it up" },
      { type: "reasoning-end", data: undefined },
    ]);
    const thinking = closed.blocks.find((block) => block.kind === "thinking")?.thinking;
    expect(thinking?.streaming).toBe(false);
    expect(thinking?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("shows a call as running before its result, and its file content as it streams", async () => {
    const view = await streaming([
      { type: "tool-input-start", data: { toolCallId: "c1", toolName: "write" } },
      { type: "tool-input-delta", data: { toolCallId: "c1", delta: '{"path":"out.txt","content":"line one\\nline t' } },
    ]);

    const tool = view.blocks.find((block) => block.kind === "tool")?.tool;
    expect(tool).toMatchObject({
      name: "write",
      state: "running",
      // The path reaches the title from the partial input, and the body shows
      // the file filling in rather than staying blank until the call lands.
      summary: "out.txt",
      streamingContent: "line one\nline t",
    });
  });


  it("nests a subagent's own tools and prose under its task row", async () => {
    // Without this the row said "running" and nothing else for the whole run,
    // which tells you neither what the subagent is doing nor whether it is
    // stuck. loop already emits every piece; none of it was being read.
    const view = await streaming([
      { type: "tool-input-start", data: { toolCallId: "c1", toolName: "task" } },
      {
        type: "tool-call",
        data: {
          toolCallId: "c1",
          toolName: "task",
          input: { agent: "explore", prompt: "find the auth code" },
        },
      },
      {
        type: "subagent-tool",
        data: { toolCallId: "c1", agent: "explore", toolName: "grep", input: { pattern: "login" } },
      },
      { type: "subagent-delta", data: { toolCallId: "c1", agent: "explore", text: "checking " } },
      { type: "subagent-delta", data: { toolCallId: "c1", agent: "explore", text: "the router" } },
      {
        type: "subagent-tool",
        data: {
          toolCallId: "c1",
          agent: "explore",
          toolName: "read",
          input: { path: `${CWD}/auth.ts` },
        },
      },
      { type: "subagent-step-usage", data: { toolCallId: "c1", agent: "explore", steps: 2, usd: 0.012 } },
    ]);

    const tool = view.blocks.find((block) => block.kind === "tool")?.tool;
    expect(tool?.name).toBe("task");
    expect(tool?.state).toBe("running");
    // Deltas merge into one run, and a tool call between them closes it — so
    // the log reads as a sequence rather than one token per line.
    expect(tool?.activity).toEqual([
      "grep login",
      "text checking the router",
      "read auth.ts",
    ]);
    // Live step count and spend ride the status, the way the terminal shows
    // them. Elapsed is the row's own clock and is not asserted here.
    expect(tool?.status).toBe("read · step 2 · $0.0120");
  });

  it("keeps a subagent log bounded, and says how much it dropped", async () => {
    const events: LoopEventPart[] = [
      { type: "tool-input-start", data: { toolCallId: "c1", toolName: "task" } },
      { type: "tool-call", data: { toolCallId: "c1", toolName: "task", input: { agent: "explore" } } },
    ];
    for (let index = 0; index < 70; index += 1) {
      events.push({
        type: "subagent-tool",
        data: { toolCallId: "c1", agent: "explore", toolName: "read", input: { path: `f${index}.ts` } },
      });
    }
    const view = await streaming(events);
    const activity = view.blocks.find((block) => block.kind === "tool")?.tool?.activity ?? [];
    expect(activity).toHaveLength(60);
    // The tail is kept: it is where the run currently is.
    expect(activity[activity.length - 1]).toBe("read f69.ts");
  });

  it("marks where the context was compacted, mid-turn and after", async () => {
    // Nothing on screen changes when loop compacts — the earlier messages are
    // still there — but the model can no longer see them, so without a marker
    // the next reply reads as the agent having forgotten the conversation.
    const live = await streaming([
      { type: "text-delta", data: "starting" },
      { type: "compact-start", data: { reason: "auto" } },
    ]);
    expect(live.shape).toEqual(["user go", "assistant starting", "compact Compacting context…"]);

    const done = await streaming([
      { type: "compact-start", data: { reason: "manual" } },
      {
        type: "compact-end",
        data: { summary: "we fixed the router", tokensBefore: 148_000, tokensAfter: 22_400 },
      },
      { type: "text-delta", data: "carrying on" },
    ]);
    expect(done.shape).toEqual([
      "user go",
      "compact Context compacted · 148k → 22k tokens",
      "assistant carrying on",
    ]);
  });

  it("closes a compaction the turn was aborted during", async () => {
    // runTurn emits `compact-end` on abort, but a dropped connection does not
    // — and a row stuck on "Compacting…" forever is worse than saying so.
    const view = await renderTranscript({
      history: [userEntry("go")],
      events: [{ type: "compact-start", data: { reason: "auto" } }],
      running: false,
    });
    expect(view.shape).toEqual(["user go", "compact Compaction cancelled"]);
  });

  it("replays a subagent run the transcript recorded", async () => {
    // MEASURED against a real session: loop does NOT persist a `task` tool
    // call inside the assistant message — it writes a separate `subagent`
    // entry. Reading only the assistant's content therefore showed no
    // subagent at all on reload, however long it had run.
    const view = await renderTranscript({
      history: [
        userEntry("delegate it"),
        {
          type: "subagent",
          ts: 1_700_000_002_000,
          id: "sa1",
          agent: "explore",
          prompt: "find the auth code",
          result: "It lives in src/auth.ts.",
          toolCallId: "call-9",
          steps: 4,
          durationMs: 12_000,
          usd: 0.0123,
          activity: [
            { type: "reasoning", text: "start with a grep" },
            { type: "tool", name: "grep", summary: "login in src" },
            { type: "text", text: "found it" },
          ],
        },
        assistant([{ type: "text", text: "It is in src/auth.ts." }], 1_700_000_003_000, "a2"),
      ],
    });

    const tool = view.blocks.find((block) => block.kind === "tool")?.tool;
    expect(tool?.name).toBe("task");
    expect(tool?.state).toBe("success");
    expect(tool?.output).toBe("It lives in src/auth.ts.");
    // The persisted run carries loop's own formatted argument line, so it is
    // used as-is rather than re-derived from an input that is not there.
    expect(tool?.activity).toEqual([
      "thinking start with a grep",
      "grep login in src",
      "text found it",
    ]);
    expect(tool?.status).toBe("done · 4 steps · 12s · $0.0123");
    expect(view.shape).toEqual([
      "user delegate it",
      "tool task find the auth code",
      "assistant It is in src/auth.ts.",
    ]);
  });


  it("replays a compaction the transcript recorded", async () => {
    const view = await renderTranscript({
      history: [
        userEntry("go"),
        {
          type: "compact",
          ts: 1_700_000_002_000,
          id: "k1",
          summary: "earlier work",
          // The first message the compaction kept: everything from here on
          // follows the marker (the terminal's rule — replay.ts).
          cutAt: 1,
          tokensBefore: 90_000,
          tokensAfter: 12_000,
        },
        assistant([{ type: "text", text: "after the cut" }], 1_700_000_003_000, "a2"),
      ],
    });
    expect(view.shape).toEqual([
      "user go",
      "compact Context compacted · 90k → 12k tokens",
      "assistant after the cut",
    ]);
  });

  it("freezes a call the turn ended on top of as interrupted", async () => {
    const view = await renderTranscript({
      history: [userEntry("go")],
      events: [
        { type: "tool-input-start", data: { toolCallId: "c1", toolName: "bash" } },
        { type: "tool-call", data: { toolCallId: "c1", toolName: "bash", input: { command: "sleep 60" } } },
      ],
      running: false,
    });

    expect(view.blocks.find((block) => block.kind === "tool")?.tool?.state).toBe("interrupted");
  });
});

describe("a question the agent is waiting on", () => {
  it("becomes the pending input the panel reads, carrying loop's askId", async () => {
    // loop's ask tool pauses the turn on this event. The UI already renders
    // `user-input.requested` as an answer panel, so no new component is
    // needed — but the requestId must be loop's askId, or the answer cannot be
    // routed back to the tool call that is waiting on it.
    const view = await renderTranscript({
      history: [userEntry("do the thing")],
      events: [
        { type: "text-delta", data: "Before I start…" },
        {
          type: "ask",
          data: {
            askId: "ask-7",
            questions: [
              {
                question: "Which database?",
                header: "Storage",
                options: [
                  { label: "SQLite", description: "local file" },
                  { label: "Postgres", description: "server" },
                ],
              },
            ],
          },
        },
      ],
      running: true,
    });

    const pending = derivePendingUserInputs(view.activities);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe("ask-7");
    expect(pending[0]?.questions[0]?.question).toBe("Which database?");
    expect(pending[0]?.questions[0]?.options.map((o) => o.label)).toEqual(["SQLite", "Postgres"]);
  });

  it("is gone once the turn finishes", async () => {
    // A turn cannot end still waiting on an answer.
    const view = await renderTranscript({
      history: [userEntry("go")],
      events: [
        { type: "ask", data: { askId: "ask-1", questions: [{ question: "?", header: "h", options: [] }] } },
      ],
      running: false,
    });
    expect(derivePendingUserInputs(view.activities)).toHaveLength(0);
  });
});
