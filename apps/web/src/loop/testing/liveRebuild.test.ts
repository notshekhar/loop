import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { clearLiveTurn } from "../handlers/liveTurn.ts";
import { threadStream } from "../handlers/thread.ts";
import { forgetTranscriptsForTests } from "../transcript/store.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

/**
 * Does the transcript actually REBUILD while a turn is running?
 *
 * The report was that nothing appears until a turn finishes and then
 * everything lands at once. The per-stage rendering is already covered
 * (`toolStates.test.ts`) and passes — so the question left is whether the
 * stream that feeds it emits anything mid-turn. This subscribes to
 * `threadStream` exactly as the app does and counts the snapshots.
 */
/** Deliver one `session.event` the way loop's transport does, numbered in order. */
type Emit = (part: { type: string; data?: unknown }) => void;

async function collectSnapshots(
  sessionId: string,
  drive: (emit: Emit) => void,
  ms = 600,
): Promise<{ count: number; last: Record<string, unknown> | null }> {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  const listeners = new Set<(event: never) => void>();
  window.loop = {
    call: (method) =>
      method === "session.history"
        ? Promise.resolve({
            sessionId,
            info: { cwd: "/w", provider: "kimi", model: "kimi/k3", createdAt: 1_700_000_000_000 },
            entries: [],
            seq: 0,
            running: true,
          })
        : Promise.resolve({}),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    anchorCwd: () => Promise.resolve(undefined),
  };
  let seq = 0;
  const emit: Emit = (part) => {
    seq += 1;
    for (const listener of listeners) listener({ sessionId, seq, part } as never);
  };

  const snapshots: Record<string, unknown>[] = [];
  const fiber = Effect.runFork(
    threadStream(sessionId).pipe(
      Stream.tap((item) =>
        Effect.sync(() => {
          if ((item as { kind?: string }).kind === "snapshot") {
            snapshots.push(
              ((item as { snapshot?: { thread?: Record<string, unknown> } }).snapshot?.thread ??
                {}) as Record<string, unknown>,
            );
          }
        }),
      ),
      Stream.runDrain,
    ),
  );

  try {
    // Let the initial snapshot land before driving the turn.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const before = snapshots.length;
    drive(emit);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return {
      count: snapshots.length - before,
      last: snapshots[snapshots.length - 1] ?? null,
    };
  } finally {
    await Effect.runPromise(Effect.asVoid(Effect.exit(Effect.interrupt))).catch(() => undefined);
    void fiber;
    clearLiveTurn(sessionId);
    forgetTranscriptsForTests();
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  }
}

describe("rebuilding while a turn runs", () => {
  it("emits a fresh snapshot after live events arrive", async () => {
    const sessionId = "01REBUILD1";
    const { count } = await collectSnapshots(sessionId, (emit) => {
      emit({ type: "tool-input-start", data: { toolName: "write", toolCallId: "t1" } });
      emit({ type: "tool-input-delta", data: { toolCallId: "t1", delta: '{"path":"a.txt"' } });
    });
    expect(count).toBeGreaterThan(0);
  });

  it("reports the turn as running so the UI can show it is working", async () => {
    // `running` false throughout is what leaves the composer with no Stop
    // button and the transcript looking idle mid-turn.
    const sessionId = "01REBUILD2";
    const { last } = await collectSnapshots(sessionId, (emit) => {
      emit({ type: "text-delta", data: "hello" });
    });
    const latestTurn = last?.latestTurn as { state?: string } | null | undefined;
    expect(latestTurn?.state).toBe("running");
  });

  it("carries the in-flight tool row into the snapshot", async () => {
    const sessionId = "01REBUILD3";
    const { last } = await collectSnapshots(sessionId, (emit) => {
      emit({ type: "tool-input-start", data: { toolName: "read", toolCallId: "t9" } });
    });
    const activities = (last?.activities ?? []) as { summary?: string }[];
    expect(activities.some((activity) => (activity.summary ?? "").includes("read"))).toBe(true);
  });
});
