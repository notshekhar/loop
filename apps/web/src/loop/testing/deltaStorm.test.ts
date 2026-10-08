/**
 * What a streaming tool input is allowed to cost.
 *
 * MEASURED in the real desktop app: kimi streams one `write` as ~2600
 * `tool-input-delta` events. Every listener ran on every one of them — and the
 * shell's listener rebuilds the whole sidebar (`session.list` across every
 * project), which no delta can have changed. The renderer's main thread was
 * blocked 78% of the wall clock, with single freezes of 22 seconds, so the
 * transcript did not paint until the storm ended. That is the whole of the
 * "write/edit only render when they're done" report: the rows were being
 * produced correctly and the UI had no cycles left to draw them.
 */
import { describe, expect, it } from "vite-plus/test";

import { applyLoopEvent, beginLiveTurn, clearLiveTurn, onLiveTurnChange } from "../handlers/liveTurn.ts";

const globals = globalThis as { window?: Window & typeof globalThis };
globals.window ??= globals as unknown as Window & typeof globalThis;
window.loop ??= {
  call: () => Promise.resolve({}),
  onEvent: () => () => {},
  anchorCwd: () => Promise.resolve(undefined),
};

let seed = 0;
const session = () => `01STORM${(seed += 1)}`;

describe("a delta storm", () => {
  it("only calls a turn starting, asking or ending a lifecycle change", () => {
    const id = session();
    const lifecycle: boolean[] = [];
    const stop = onLiveTurnChange((changed, _structural, isLifecycle) => {
      if (changed === id) lifecycle.push(isLifecycle);
    });
    beginLiveTurn(id);
    expect(lifecycle).toEqual([true]);
    lifecycle.length = 0;
    // A tool-heavy reply: structural, but nothing a session list shows.
    applyLoopEvent(id, { type: "text-delta", data: "Looking." });
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "c1", toolName: "bash" } });
    applyLoopEvent(id, { type: "tool-call", data: { toolCallId: "c1", toolName: "bash", input: {} } });
    applyLoopEvent(id, { type: "tool-result", data: { toolCallId: "c1", output: "ok" } });
    applyLoopEvent(id, { type: "reasoning-start" });
    expect(lifecycle.every((value) => value === false)).toBe(true);
    // A question opening is shown ("needs you"), and so is the turn ending.
    applyLoopEvent(id, { type: "ask", data: { askId: "a1", questions: [] } });
    expect(lifecycle.at(-1)).toBe(true);
    applyLoopEvent(id, { type: "finish", data: {} });
    expect(lifecycle.at(-1)).toBe(true);
    stop();
    clearLiveTurn(id);
  });

  it("tells subscribers a delta is not a structural change", () => {
    const id = session();
    const structural: boolean[] = [];
    const stop = onLiveTurnChange((changed, isStructural) => {
      if (changed === id) structural.push(isStructural);
    });
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "c1", toolName: "write" } });
    structural.length = 0;
    for (let i = 0; i < 50; i++) {
      applyLoopEvent(id, { type: "tool-input-delta", data: { toolCallId: "c1", delta: "x" } });
    }
    applyLoopEvent(id, { type: "text-delta", data: "hello" });
    applyLoopEvent(id, { type: "reasoning-delta", data: "thinking" });
    expect(structural.every((value) => value === false)).toBe(true);
    // The call returning is structural — the sidebar's mtime really did move.
    applyLoopEvent(id, { type: "tool-result", data: { toolCallId: "c1", output: "ok" } });
    expect(structural.at(-1)).toBe(true);
    stop();
    clearLiveTurn(id);
  });

  it("marks the events that change what the conversation IS", () => {
    const id = session();
    const structural: boolean[] = [];
    const stop = onLiveTurnChange((changed, isStructural) => {
      if (changed === id) structural.push(isStructural);
    });
    beginLiveTurn(id);
    structural.length = 0;
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "c1", toolName: "write" } });
    applyLoopEvent(id, { type: "tool-call", data: { toolCallId: "c1", toolName: "write", input: {} } });
    applyLoopEvent(id, { type: "finish", data: {} });
    expect(structural).toEqual([true, true, true]);
    stop();
    clearLiveTurn(id);
  });
});
