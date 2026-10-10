/**
 * The transcript-to-conversation mapping.
 *
 * These run against synthetic loop payloads on purpose. Two of the three
 * mappings are impractical to prove against a live provider: the `plan` tool
 * only fires when a model decides to propose a plan, and reasoning text comes
 * back ENCRYPTED from several providers (`text: ""` plus an opaque
 * `reasoningEncryptedContent`), so a live turn can legitimately produce no
 * visible thinking at all. Pinning them here is the only way to know the
 * mapping is right rather than merely untriggered.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { applyLoopEvent, beginLiveTurn, clearLiveTurn, readLiveTurn } from "./liveTurn.ts";
import { buildThread } from "./thread.ts";

const globals = globalThis as { window?: Window & typeof globalThis };
const SESSION = "01SESSION";

const info = {
  cwd: "/w/project",
  provider: "kimi",
  model: "kimi/k3",
  createdAt: 1_700_000_000_000,
};

async function threadOf(entries: readonly unknown[], running = false) {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: (method) =>
      method === "session.history"
        ? Promise.resolve({ sessionId: SESSION, info, entries, seq: entries.length, running })
        : Promise.resolve({}),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };
  try {
    return await Effect.runPromise(buildThread(SESSION));
  } finally {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  }
}

const userEntry = (text: string, id = "u1") => ({
  type: "message",
  role: "user",
  content: text,
  ts: 1_700_000_001_000,
  id,
});

describe("a loop transcript as a conversation", () => {
  it("keeps the user's text and the assistant's reply in order", async () => {
    const thread = await threadOf([
      userEntry("what is 12*13?"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [{ type: "text", text: "156" }],
      },
    ]);
    expect(thread.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "what is 12*13?"],
      ["assistant", "156"],
    ]);
    expect(thread.projectId).toBe("/w/project");
  });

  it("renders loop's plan tool call as a proposed plan, not a tool row", async () => {
    // This is the whole reason the plan card needs no new loop protocol:
    // `input.plan` already IS the markdown document the card renders.
    const planMarkdown = "# Plan\n\n1. Do the thing\n2. Verify it";
    const thread = await threadOf([
      userEntry("plan this"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "tool-call", toolName: "plan", toolCallId: "call-1", input: { plan: planMarkdown } },
        ],
      },
    ]);
    expect(thread.proposedPlans).toHaveLength(1);
    expect(thread.proposedPlans[0]?.planMarkdown).toBe(planMarkdown);
    expect(thread.activities.filter((a) => a.kind.startsWith("tool."))).toHaveLength(0);
  });

  it("renders reasoning as the kind the work log shows as thinking", async () => {
    const thread = await threadOf([
      userEntry("think"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "reasoning", text: "Considering the options." },
          { type: "text", text: "Done." },
        ],
      },
    ]);
    const thinking = thread.activities.filter((a) => a.kind === "task.progress");
    expect(thinking).toHaveLength(1);
    expect((thinking[0]?.payload as { detail?: string }).detail).toBe("Considering the options.");
  });

  it("drops reasoning parts the provider returned encrypted", async () => {
    // Measured against a real kimi transcript: the part is present but its
    // text is empty, with the content in an opaque providerOptions field.
    // An empty thinking row is noise, so it must not be emitted.
    const thread = await threadOf([
      userEntry("think"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "reasoning", text: "", providerOptions: { openai: { reasoningEncryptedContent: "gAAA" } } },
          { type: "text", text: "Done." },
        ],
      },
    ]);
    expect(thread.activities.filter((a) => a.kind === "task.progress")).toHaveLength(0);
  });

  it("attaches a tool's result to the row that called it", async () => {
    const thread = await threadOf([
      userEntry("run it"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          {
            type: "tool-call",
            toolName: "bash",
            toolCallId: "call-1",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        type: "message",
        role: "tool",
        id: "t1",
        ts: 1_700_000_003_000,
        content: [{ type: "tool-result", toolCallId: "call-1", output: { type: "text", value: "hi\n" } }],
      },
    ]);
    const tools = thread.activities.filter((a) => a.kind === "tool.bash");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.summary).toBe("bash echo hi");
    // The result replaces the input as the row's detail once it arrives.
    expect((tools[0]?.payload as { detail?: string }).detail).toContain("hi");
  });

  it("reports a running session so the composer shows the turn in flight", async () => {
    const thread = await threadOf([userEntry("go")], true);
    expect(thread.session?.status).toBe("running");
  });

  it("titles a thread from the first thing the user asked", async () => {
    const thread = await threadOf([userEntry("fix the flaky test")]);
    expect(thread.title).toBe("fix the flaky test");
  });
});

/**
 * The row the web draws has to say what the terminal row says, and that needs
 * the call itself — not a flattened one-line detail. These pin the structured
 * copy the loop renderer reads.
 */
describe("what a tool row is given to draw with", () => {
  const readCall = (input: Record<string, unknown>) => [
    userEntry("read it"),
    {
      type: "message",
      role: "assistant",
      id: "a1",
      ts: 1_700_000_002_000,
      content: [{ type: "tool-call", toolName: "read", toolCallId: "call-1", input }],
    },
  ];
  const loopTool = (thread: Awaited<ReturnType<typeof threadOf>>, kind: string) =>
    (thread.activities.find((a) => a.kind === kind)?.payload as { loopTool?: Record<string, unknown> })
      ?.loopTool;

  it("keeps the call's arguments as an object, not a stringified blob", async () => {
    // `offset` is what makes the row read `read src/app.ts:120-180` and what
    // numbers its output lines. Flattened to a string, both are impossible.
    const thread = await threadOf(readCall({ path: "/w/project/src/app.ts", offset: 120, limit: 61 }));
    expect(loopTool(thread, "tool.read")?.args).toEqual({
      path: "/w/project/src/app.ts",
      offset: 120,
      limit: 61,
    });
  });

  it("unwraps the persisted {type,value} envelope so output is text", async () => {
    // MEASURED against a live transcript: this is the shape loop persists, and
    // stringifying it renders `{"type":"text","value":"3\n"}` where the file
    // lines, the diff or the stdout should be.
    const thread = await threadOf([
      userEntry("run it"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "tool-call", toolName: "bash", toolCallId: "call-1", input: { command: "wc -l" } },
        ],
      },
      {
        type: "message",
        role: "tool",
        id: "t1",
        ts: 1_700_000_003_000,
        content: [
          { type: "tool-result", toolCallId: "call-1", output: { type: "text", value: "3\n" } },
        ],
      },
    ]);
    expect(loopTool(thread, "tool.bash")?.output).toBe("3\n");
  });

  it("reads a failure out of the envelope type, not just an isError flag", async () => {
    const thread = await threadOf([
      userEntry("read it"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "tool-call", toolName: "read", toolCallId: "call-1", input: { path: "/w/project/gone.ts" } },
        ],
      },
      {
        type: "message",
        role: "tool",
        id: "t1",
        ts: 1_700_000_003_000,
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            output: { type: "error-text", value: "Error: File has not been read in this session" },
          },
        ],
      },
    ]);
    expect(loopTool(thread, "tool.read")?.isError).toBe(true);
    expect(loopTool(thread, "tool.read")?.output).toContain("has not been read");
  });

  it("unwraps a tool result to its text so a diff stays a diff", async () => {
    const thread = await threadOf([
      userEntry("edit it"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "tool-call", toolName: "edit", toolCallId: "call-1", input: { path: "/w/project/a.ts" } },
        ],
      },
      {
        type: "message",
        role: "tool",
        id: "t1",
        ts: 1_700_000_003_000,
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            output: { content: [{ type: "text", text: "-old\n+new" }], isError: false },
          },
        ],
      },
    ]);
    // Not `{"content":[{"type":"text"…` — the text IS the rendered body.
    expect(loopTool(thread, "tool.edit")?.output).toBe("-old\n+new");
    expect(loopTool(thread, "tool.edit")?.isError).toBe(false);
    expect(loopTool(thread, "tool.edit")?.isPartial).toBe(false);
  });

  it("marks a failed call so the row can go red", async () => {
    const thread = await threadOf([
      userEntry("run it"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "tool-call", toolName: "bash", toolCallId: "call-1", input: { command: "false" } },
        ],
      },
      {
        type: "message",
        role: "tool",
        id: "t1",
        ts: 1_700_000_003_000,
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            output: { content: [{ type: "text", text: "exit 1" }], isError: true },
          },
        ],
      },
    ]);
    expect(loopTool(thread, "tool.bash")?.isError).toBe(true);
  });

  it("gives a replayed thinking block its text but no invented duration", async () => {
    const thread = await threadOf([
      userEntry("think"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [{ type: "reasoning", text: "Weighing it up." }],
      },
    ]);
    const thinking = (
      thread.activities.find((a) => a.kind === "task.progress")?.payload as {
        loopThinking?: Record<string, unknown>;
      }
    )?.loopThinking;
    expect(thinking).toEqual({ text: "Weighing it up.", streaming: false });
  });

  it("renders a persisted recap as its own row", async () => {
    // Recaps persist as custom entries so a resumed session re-renders them;
    // they are not messages and never enter the model's context.
    const thread = await threadOf([
      userEntry("do it"),
      {
        type: "custom",
        ts: 1_700_000_004_000,
        id: "c1",
        payload: { kind: "recap", text: "Renamed the flag.\nUpdated its two call sites." },
      },
    ]);
    const recap = thread.activities.find((a) => a.kind === "loop.recap");
    expect((recap?.payload as { loopRecap?: { text: string } })?.loopRecap?.text).toBe(
      "Renamed the flag.\nUpdated its two call sites.",
    );
  });

  it("does not double a call the transcript already holds", async () => {
    // The live overlay retires as a whole, and only when the transcript's
    // text matches what it was holding. A turn whose reply was empty leaves
    // it in place — and then the same call renders twice, once settled and
    // once stuck on "running" forever. Matching per call id is exact.
    beginLiveTurn(SESSION);
    applyLoopEvent(SESSION, {
      type: "tool-input-start",
      data: { toolCallId: "call-1", toolName: "read" },
    });
    const thread = await threadOf([
      userEntry("read it"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "tool-call", toolName: "read", toolCallId: "call-1", input: { path: "/w/project/a.ts" } },
        ],
      },
    ]);
    expect(thread.activities.filter((a) => a.kind === "tool.read")).toHaveLength(1);
    clearLiveTurn(SESSION);
  });

  it("does not double a multi-run reply the transcript already holds", async () => {
    // The reported bug: a turn that called a tool renders its whole answer
    // twice. A tool call closes the current text run, so the turn is several
    // runs; retirement compared the JOIN of them against the transcript's LAST
    // assistant message, never matched, and left the overlay on top of a
    // transcript that already had every line.
    beginLiveTurn(SESSION);
    applyLoopEvent(SESSION, { type: "text-delta", data: "Reading the anchors." });
    applyLoopEvent(SESSION, {
      type: "tool-input-start",
      data: { toolCallId: "call-1", toolName: "read" },
    });
    applyLoopEvent(SESSION, { type: "text-delta", data: "Done. Wrote the story." });
    applyLoopEvent(SESSION, { type: "finish" });

    const thread = await threadOf([
      userEntry("write a story"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "text", text: "Reading the anchors." },
          {
            type: "tool-call",
            toolName: "read",
            toolCallId: "call-1",
            input: { path: "/w/project/a.md" },
          },
          { type: "text", text: "Done. Wrote the story." },
        ],
      },
    ]);

    expect(thread.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(
      thread.messages.filter((message) => message.text === "Done. Wrote the story."),
    ).toHaveLength(1);
    clearLiveTurn(SESSION);
  });

  it("streams a reply as part of the turn its prompt opened, not a second turn", async () => {
    // Mid-reply the transcript already holds the prompt (and any finished
    // step); the overlay streaming the rest used to carry an id of its own,
    // so the phone split one reply into two turns — two copy buttons, two
    // groups — until the turn ended and the transcript took over.
    beginLiveTurn(SESSION);
    applyLoopEvent(SESSION, { type: "text-delta", data: "Looking now." });
    applyLoopEvent(SESSION, {
      type: "tool-input-start",
      data: { toolCallId: "call-live", toolName: "read" },
    });
    applyLoopEvent(SESSION, { type: "text-delta", data: "Still going" });

    const thread = await threadOf([userEntry("check the repo", "u-live")], true);
    const turnIds = new Set(
      [...thread.messages, ...thread.activities]
        .map((item) => (item as { turnId?: string | null }).turnId)
        .filter((id): id is string => typeof id === "string"),
    );
    expect([...turnIds]).toEqual(["u-live"]);
    // And in the order it streamed: text, the tool, then the text after it.
    const order = [
      ...thread.messages.map((m) => ({ at: m.createdAt, what: `text:${m.text}` })),
      ...thread.activities.map((a) => ({ at: a.createdAt, what: "tool" })),
    ]
      .filter((item) => item.what !== "text:check the repo")
      .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))
      .map((item) => item.what);
    expect(order).toEqual(["text:Looking now.", "tool", "text:Still going"]);
    clearLiveTurn(SESSION);
  });

  it("keeps a recap last when the transcript has caught up mid-overlay", async () => {
    // Same root cause, seen as an ordering inversion: history is folded first,
    // so a live run it already held was re-emitted AFTER the persisted recap
    // and the recap appeared above the end of the answer.
    beginLiveTurn(SESSION);
    applyLoopEvent(SESSION, { type: "text-delta", data: "Reading the anchors." });
    applyLoopEvent(SESSION, {
      type: "tool-input-start",
      data: { toolCallId: "call-1", toolName: "read" },
    });
    applyLoopEvent(SESSION, { type: "text-delta", data: "Done. Wrote the story." });
    applyLoopEvent(SESSION, { type: "finish" });

    const thread = await threadOf([
      userEntry("write a story"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "text", text: "Reading the anchors." },
          {
            type: "tool-call",
            toolName: "read",
            toolCallId: "call-1",
            input: { path: "/w/project/a.md" },
          },
          { type: "text", text: "Done. Wrote the story." },
        ],
      },
      {
        type: "custom",
        ts: 1_700_000_003_000,
        id: "c1",
        payload: { kind: "recap", text: "Wrote stories/monday-shirt.md." },
      },
    ]);

    const recap = thread.activities.find((activity) => activity.kind === "loop.recap");
    const lastReply = thread.messages.findLast((message) => message.role === "assistant");
    expect(recap).toBeDefined();
    expect(lastReply?.text).toBe("Done. Wrote the story.");
    expect(recap!.createdAt > lastReply!.createdAt).toBe(true);
    clearLiveTurn(SESSION);
  });

  it("ignores a custom entry that is not a recap", async () => {
    const thread = await threadOf([
      userEntry("do it"),
      { type: "custom", ts: 1_700_000_004_000, id: "c1", payload: { kind: "something-else" } },
    ]);
    expect(thread.activities.filter((a) => a.kind === "loop.recap")).toHaveLength(0);
  });
});

/**
 * Picking up a turn this client did not start.
 *
 * loop persists a turn only once it ends and broadcasts only to clients that
 * have attached, so a session already running when the thread is opened —
 * started in the terminal, in another window, or before the app was restarted
 * — has nothing on disk and nothing in flight to catch. It rendered as a
 * settled conversation sitting perfectly still while the agent worked.
 */
describe("attaching to a session", () => {
  /** Drives one attach and reports the arguments loop was called with. */
  async function attachOf(input: {
    readonly running: boolean;
    readonly resync?: boolean;
    readonly sessionId: string;
  }) {
    const hadWindow = globals.window !== undefined;
    globals.window ??= globals as unknown as Window & typeof globalThis;
    const previous = window.loop;
    const calls: Array<{ method: string; params: unknown }> = [];
    window.loop = {
      call: (method, params) => {
        calls.push({ method, params });
        if (method === "session.history") {
          return Promise.resolve({
            sessionId: input.sessionId,
            info,
            entries: [],
            seq: 0,
            running: false,
          });
        }
        if (method === "session.attach") {
          return Promise.resolve({
            ok: true,
            running: input.running,
            ...(input.resync === undefined ? {} : { resync: input.resync }),
          });
        }
        return Promise.resolve({});
      },
      onEvent: () => () => {},
      anchorCwd: () => Promise.resolve(undefined),
    };
    try {
      const { threadStream } = await import("./thread.ts");
      // One snapshot is enough: the attach happens before it is built.
      const head = await Effect.runPromise(Stream.runHead(threadStream(input.sessionId)));
      return { calls, thread: Option.getOrThrow(head) };
    } finally {
      if (previous === undefined) delete window.loop;
      else window.loop = previous;
      if (!hadWindow) delete globals.window;
    }
  }

  it("asks loop to replay from the last event it applied", async () => {
    // Without `afterSeq` loop subscribes but replays nothing, so everything
    // that happened before this client arrived is simply never seen.
    const { calls } = await attachOf({ running: true, sessionId: "01ATTACH1" });
    const attach = calls.find((call) => call.method === "session.attach");
    expect(attach).toBeDefined();
    expect((attach?.params as { afterSeq?: number }).afterSeq).toBe(0);
  });

  it("shows a session already running as running", async () => {
    // The transcript is empty and no event has landed yet — `running` from the
    // attach response is the only thing that knows a turn is in flight.
    const { thread } = await attachOf({ running: true, sessionId: "01ATTACH2" });
    const snapshot = (thread as { snapshot: { thread: { session: { status: string } } } }).snapshot;
    expect(snapshot.thread.session.status).toBe("running");
    clearLiveTurn("01ATTACH2");
  });

  it("leaves an idle session idle", async () => {
    const { thread } = await attachOf({ running: false, sessionId: "01ATTACH3" });
    const snapshot = (thread as { snapshot: { thread: { session: { status: string } } } }).snapshot;
    expect(snapshot.thread.session.status).toBe("idle");
  });
});

/**
 * The thread detail has to answer to the id the CLIENT knows.
 *
 * `buildShellSnapshot` already reports threads under `clientThreadIdFor`, and
 * `mergeEnvironmentThread` bails outright on `detail.id !== shell.id`. So a
 * detail carrying loop's own id did not merely look inconsistent — it silently
 * dropped the shell's half of the thread, and left ChatView deriving
 * `activeThreadRef` from one id while reading its terminal state under the
 * other. The terminal button wrote `terminalOpen: true` under loop's id, the
 * drawer looked for it under the route's, and the drawer never mounted.
 */
describe("which id a thread reports itself under", () => {
  it("uses the client's thread id, not loop's session id", async () => {
    const clientThreadId = "01CLIENTTHREAD";
    const loopSessionId = "01LOOPSESSION";
    const hadWindow = globals.window !== undefined;
    globals.window ??= globals as unknown as Window & typeof globalThis;
    const previous = window.loop;
    window.loop = {
      call: (method) => {
        if (method === "session.create") return Promise.resolve({ sessionId: loopSessionId });
        if (method === "session.history") {
          return Promise.resolve({
            sessionId: loopSessionId,
            info,
            entries: [userEntry("hi")],
            seq: 1,
            running: false,
          });
        }
        return Promise.resolve({});
      },
      onEvent: () => () => {},
      anchorCwd: () => Promise.resolve(undefined),
      fs: {
        list: () => Promise.reject(new Error("unused")),
        read: () => Promise.reject(new Error("unused")),
        browse: (path: string) =>
          Promise.resolve({ parentPath: path.replace(/\/$/, "") } as never),
      },
    };
    try {
      const { dispatchCommand } = await import("./dispatch.ts");
      // The only way a binding exists: the composer creates a draft and the
      // first turn mints loop's session behind it.
      for (const command of [
        {
          type: "thread.create",
          commandId: "cmd-create",
          threadId: clientThreadId,
          projectId: info.cwd,
          title: "New thread",
          modelSelection: { instanceId: "kimi", model: "kimi/k3" },
          runtimeMode: "full-access",
          interactionMode: "chat",
          branch: null,
          worktreePath: null,
          createdAt: "2026-08-08T00:00:00.000Z",
        },
        {
          type: "thread.turn.start",
          commandId: "cmd-turn",
          threadId: clientThreadId,
          message: { messageId: "m1", text: "hi" },
        },
      ]) {
        await Effect.runPromise(dispatchCommand(command as never));
      }

      const thread = await Effect.runPromise(buildThread(loopSessionId));
      expect(thread.id).toBe(clientThreadId);
      expect(thread.session?.threadId).toBe(clientThreadId);
    } finally {
      clearLiveTurn(loopSessionId);
      if (previous === undefined) delete window.loop;
      else window.loop = previous;
      if (!hadWindow) delete globals.window;
    }
  });
});

/**
 * loop is the authority on whether a turn is running; the overlay is not.
 *
 * `live.running` closes only on `finish`/`error`, so a lost end event left the
 * composer on Stop and the timeline counting "Working for 12m" until restart —
 * and because `threadStream` only rebuilds when a live turn CHANGES, a turn
 * that had stopped changing was never re-examined.
 */
describe("a live turn whose end never arrived", () => {
  async function statusAfterQuiet(input: {
    readonly sessionId: string;
    readonly running: boolean;
    readonly quietFor: number;
  }) {
    const hadWindow = globals.window !== undefined;
    globals.window ??= globals as unknown as Window & typeof globalThis;
    const previous = window.loop;
    window.loop = {
      call: (method) =>
        method === "session.history"
          ? Promise.resolve({
              sessionId: input.sessionId,
              info,
              entries: [userEntry("hi")],
              seq: 1,
              running: input.running,
            })
          : Promise.resolve({}),
      onEvent: () => () => {},
      anchorCwd: () => Promise.resolve(undefined),
    };
    try {
      beginLiveTurn(input.sessionId);
      applyLoopEvent(input.sessionId, { type: "text-delta", text: "half an ans" } as never);
      const turn = readLiveTurn(input.sessionId);
      if (turn) turn.lastEventAt = Date.now() - input.quietFor;
      const thread = await Effect.runPromise(buildThread(input.sessionId));
      return thread.session?.status;
    } finally {
      clearLiveTurn(input.sessionId);
      if (previous === undefined) delete window.loop;
      else window.loop = previous;
      if (!hadWindow) delete globals.window;
    }
  }

  it("goes idle once loop says the session is not running", async () => {
    const status = await statusAfterQuiet({
      sessionId: "01STUCK1",
      running: false,
      quietFor: 30_000,
    });
    expect(status).toBe("idle");
  });

  it("keeps a turn that loop still reports as running", async () => {
    // A long `bash` or a slow first token is silent and perfectly alive; only
    // loop's own answer may end a turn.
    const status = await statusAfterQuiet({
      sessionId: "01STUCK2",
      running: true,
      quietFor: 30_000,
    });
    expect(status).toBe("running");
  });

  it("does not end a turn that has only just been dispatched", async () => {
    // `beginLiveTurn` runs BEFORE `session.send` lands, so a not-running answer
    // in that window is a race with the send, not a lost turn.
    const status = await statusAfterQuiet({ sessionId: "01STUCK3", running: false, quietFor: 0 });
    expect(status).toBe("running");
  });
});

/**
 * Recovering from a core restart.
 *
 * loop tracks event subscribers per TRANSPORT, so when the desktop shell's core
 * dies and main restarts it, the attach that belonged to the old one is gone.
 * Nothing re-attached and `attached` still named the session, so the rebuild
 * path never tried again: the thread went permanently silent — turns ran to
 * completion with the transcript frozen, and only a reload brought it back.
 *
 * The recovery already existed; it was unreachable in the desktop app, because
 * `onLoopConnectionChange` returned a no-op there while main was announcing the
 * restart to nobody. These pin the wire, not just the intent.
 */
describe("a core that restarts", () => {
  function shell(input: { readonly withStatus: boolean }) {
    const hadWindow = globals.window !== undefined;
    globals.window ??= globals as unknown as Window & typeof globalThis;
    const previous = window.loop;
    const calls: Array<string> = [];
    let announce: ((running: boolean) => void) | undefined;
    const bridge: Record<string, unknown> = {
      call: (method: string) => {
        calls.push(method);
        if (method === "session.history")
          return Promise.resolve({ sessionId: "01REC", info, entries: [], seq: 0, running: false });
        if (method === "session.attach") return Promise.resolve({ ok: true, running: false });
        return Promise.resolve({});
      },
      onEvent: () => () => {},
      anchorCwd: () => Promise.resolve(undefined),
    };
    if (input.withStatus) {
      bridge["onStatus"] = (listener: (running: boolean) => void) => {
        announce = listener;
        return () => {
          announce = undefined;
        };
      };
    }
    window.loop = bridge as unknown as NonNullable<typeof window.loop>;
    return {
      calls,
      announce: (running: boolean) => announce?.(running),
      hasListener: () => announce !== undefined,
      restore: () => {
        if (previous === undefined) delete window.loop;
        else window.loop = previous;
        if (!hadWindow) delete globals.window;
      },
    };
  }

  it("subscribes to the shell's status channel", async () => {
    const s = shell({ withStatus: true });
    try {
      const { onLoopConnectionChange } = await import("../transport.ts");
      const stop = onLoopConnectionChange(() => {});
      // A no-op would never register, which is exactly the bug.
      expect(s.hasListener()).toBe(true);
      stop();
      expect(s.hasListener()).toBe(false);
    } finally {
      s.restore();
    }
  });

  it("reports the core coming back as an open connection", async () => {
    const s = shell({ withStatus: true });
    try {
      const { onLoopConnectionChange } = await import("../transport.ts");
      const seen: string[] = [];
      const stop = onLoopConnectionChange((state) => seen.push(state));
      s.announce(false);
      s.announce(true);
      stop();
      // `open` is the only state the re-attach path acts on.
      expect(seen).toEqual(["closed", "open"]);
    } finally {
      s.restore();
    }
  });

  it("is inert on a shell too old to report status", async () => {
    const s = shell({ withStatus: false });
    try {
      const { onLoopConnectionChange } = await import("../transport.ts");
      // No throw, and nothing to unsubscribe — the behaviour it had before.
      expect(() => onLoopConnectionChange(() => {})()).not.toThrow();
    } finally {
      s.restore();
    }
  });
});
