import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { deriveActivePlanState } from "../../session-logic";
import { buildThread } from "../handlers/thread.ts";
import { applyLoopEvent, beginLiveTurn, clearLiveTurn } from "../handlers/liveTurn.ts";
import { renderTranscript } from "./renderTranscript";

// History and live overlapping (the same call, run, recap or checklist in
// both) cannot happen any more: the transcript store applies only events
// after the host snapshot's seq, and the host builds that snapshot from one
// stream — see packages/core/test/transcript.test.ts ("the saved turn reads
// exactly as it streamed") and src/loop/transcript/store.ts.

const globals = globalThis as { window?: Window & typeof globalThis };

/** loop's persisted checklist entry (tools/todo.ts writes exactly this). */
const todosEntry = (items: unknown[], ts = 1_700_000_000_500) => ({
  type: "custom",
  ts,
  payload: { kind: "todos", items },
});

const REPLAYED = [
  { content: "Read the config", status: "completed" },
  { content: "Add the route", status: "in_progress", activeForm: "Adding the route" },
  { content: "Write a test", status: "pending" },
  { content: "Rename the module", status: "cancelled" },
];

/** buildThread against a stubbed bridge, the way renderTranscript does it. */
async function thread(input: {
  history?: readonly unknown[];
  events?: { type: string; data?: unknown }[];
  running?: boolean;
}) {
  const sessionId = `01TODO${Math.random().toString(36).slice(2, 8)}`;
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: (method) =>
      method === "session.history"
        ? Promise.resolve({
            sessionId,
            info: { cwd: "/w", provider: "kimi", model: "kimi/k3", createdAt: 1_700_000_000_000 },
            entries: input.history ?? [],
            seq: 1,
            running: input.running ?? false,
          })
        : Promise.resolve({}),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };
  try {
    if (input.events?.length) {
      beginLiveTurn(sessionId);
      for (const event of input.events) applyLoopEvent(sessionId, event);
    }
    return await Effect.runPromise(buildThread(sessionId));
  } finally {
    clearLiveTurn(sessionId);
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  }
}

const planOf = (built: Awaited<ReturnType<typeof thread>>) =>
  deriveActivePlanState(
    built.activities as never,
    (built.latestTurn?.turnId ?? undefined) as never,
  );

describe("the agent's checklist", () => {
  it("survives a reload — the persisted entry restores the list", async () => {
    // The CLI does the same on /resume (`latestTodos` seeds the pinned panel);
    // before this the `todos` custom entry was dropped on the floor.
    const plan = planOf(await thread({ history: [todosEntry(REPLAYED)] }));
    expect(plan?.steps.map((s) => s.status)).toEqual([
      "completed",
      "inProgress",
      "pending",
      "cancelled",
    ]);
  });

  it("shows the active label while a step is in progress", async () => {
    // loop carries a present-continuous form for exactly this, and the
    // terminal renders it in place of the imperative one.
    const plan = planOf(await thread({ history: [todosEntry(REPLAYED)] }));
    expect(plan?.steps[1]?.step).toBe("Adding the route");
    expect(plan?.steps[0]?.step).toBe("Read the config");
  });

  it("keeps only the newest list when a turn wrote several", async () => {
    // Each write REPLACES the list, so replaying every one would render a
    // stack of superseded checklists.
    const plan = planOf(
      await thread({
        history: [
          todosEntry([{ content: "Old plan", status: "pending" }], 1_700_000_000_100),
          todosEntry([{ content: "New plan", status: "completed" }], 1_700_000_000_200),
        ],
      }),
    );
    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0]?.step).toBe("New plan");
  });


  it("never becomes a row in the transcript", async () => {
    // It is current state, not something that happened — the terminal keeps it
    // out of history for the same reason.
    const view = await renderTranscript({
      history: [
        {
          type: "message",
          ts: 1_700_000_000_000,
          role: "user",
          content: [{ type: "text", text: "go" }],
        },
        todosEntry(REPLAYED),
      ],
    });
    expect(view.shape).toEqual(["user go"]);
  });
});

describe("a settled turn does not render its recap or compaction twice", () => {
  /** loop persists a recap as a custom entry; the live turn also holds one. */
  const recapEntry = (text: string, ts = 1_700_000_000_900) => ({
    type: "custom",
    ts,
    payload: { kind: "recap", text },
  });


  it("still shows a live recap the transcript has not caught up with", async () => {
    const view = await renderTranscript({
      events: [
        { type: "text-delta", data: "done" },
        { type: "data-recap", data: { text: "Fresh recap." } },
      ],
      running: true,
    });
    expect(view.shape.filter((kind) => kind.startsWith("recap"))).toHaveLength(1);
  });
});
