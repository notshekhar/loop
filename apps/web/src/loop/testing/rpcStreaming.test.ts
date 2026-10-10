import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { clearLiveTurn } from "../handlers/liveTurn.ts";
import { threadStream } from "../handlers/thread.ts";
import { forgetTranscriptsForTests } from "../transcript/store.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

/**
 * Does a live update survive the hop from `threadStream` to the client?
 *
 * `liveRebuild.test.ts` proves the stream itself emits promptly. The reported
 * symptom — nothing on screen for ~18s, then every row at once — has to happen
 * after that, and the RPC session in between is the only thing left: it wires
 * `RpcServer.makeNoSerialization` to `RpcClient.makeNoSerialization` with
 * `supportsAck: true`, so stream items are flow-controlled by acknowledgements
 * rather than pushed.
 *
 * This drives events one at a time with real gaps between them and records
 * WHEN each snapshot lands. Batching shows up as several arrivals sharing a
 * timestamp after a long quiet stretch.
 */
function stubWindow(sessionId: string) {
  const listeners = new Set<(event: never) => void>();
  let seq = 0;
  /** Deliver one `session.event` the way loop's transport does, numbered in order. */
  const emit = (part: { type: string; data?: unknown }) => {
    seq += 1;
    for (const listener of listeners) listener({ sessionId, seq, part } as never);
  };
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
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
  const restore = () => {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  };
  return { emit, restore };
}

describe("live updates reaching a subscriber", () => {
  it("delivers each step of a turn as it happens, not in one batch at the end", async () => {
    const sessionId = "01RPCSTREAM";
    const { emit, restore } = stubWindow(sessionId);
    const arrivals: { at: number; tools: number }[] = [];
    const start = Date.now();

    const fiber = Effect.runFork(
      threadStream(sessionId).pipe(
        Stream.tap((item) =>
          Effect.sync(() => {
            if ((item as { kind?: string }).kind !== "snapshot") return;
            const thread = (item as { snapshot?: { thread?: { activities?: unknown[] } } }).snapshot
              ?.thread;
            arrivals.push({
              at: Date.now() - start,
              tools: (thread?.activities ?? []).length,
            });
          }),
        ),
        Stream.runDrain,
      ),
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Three distinct steps, well separated — a batching layer collapses
      // these into one late arrival.
      emit({
        type: "tool-input-start",
        data: { toolName: "write", toolCallId: "a" },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      emit({
        type: "tool-input-start",
        data: { toolName: "read", toolCallId: "b" },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      emit({
        type: "tool-input-start",
        data: { toolName: "bash", toolCallId: "c" },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Each step should have produced its own snapshot, with the activity
      // count growing as it went — not one snapshot holding all three.
      const growth = arrivals.map((arrival) => arrival.tools);
      expect(arrivals.length).toBeGreaterThanOrEqual(3);
      expect(Math.max(...growth)).toBeGreaterThanOrEqual(3);
      // The first tool must have been visible long before the last one ran.
      const firstWithTool = arrivals.find((arrival) => arrival.tools >= 1);
      expect(firstWithTool?.at).toBeLessThan(500);
    } finally {
      void fiber;
      clearLiveTurn(sessionId);
      forgetTranscriptsForTests();
      restore();
    }
  });
});
