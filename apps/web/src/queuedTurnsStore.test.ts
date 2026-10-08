import { beforeEach, describe, expect, it } from "vite-plus/test";

import { EMPTY_QUEUE, queuedTurnsForThread, useQueuedTurnsStore } from "./queuedTurnsStore";

const turn = (id: string, sessionId = "s1", threadId = "t1") => ({
  id,
  sessionId,
  threadId,
  text: id,
  attachmentCount: 0,
  queuedAt: "2026-08-08T00:00:00.000Z",
  send: () => Promise.resolve(),
  interrupt: () => Promise.resolve(),
});

describe("the queued-turns store", () => {
  beforeEach(() => {
    useQueuedTurnsStore.setState({ queue: [] });
  });

  it("sends in the order they were typed", () => {
    const store = useQueuedTurnsStore.getState();
    store.enqueue(turn("first"));
    store.enqueue(turn("second"));

    expect(useQueuedTurnsStore.getState().takeNext("s1")?.id).toBe("first");
    expect(useQueuedTurnsStore.getState().takeNext("s1")?.id).toBe("second");
    expect(useQueuedTurnsStore.getState().takeNext("s1")).toBeUndefined();
  });

  it("keeps sessions apart", () => {
    const store = useQueuedTurnsStore.getState();
    store.enqueue(turn("mine", "s1"));
    store.enqueue(turn("theirs", "s2"));

    expect(useQueuedTurnsStore.getState().takeNext("s2")?.id).toBe("theirs");
    expect(useQueuedTurnsStore.getState().queue.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("puts a refused drain back at the FRONT", () => {
    // The turn had not really ended. Appending would silently reorder what the
    // user typed, which is the one thing a queue must not do.
    const store = useQueuedTurnsStore.getState();
    store.enqueue(turn("first"));
    store.enqueue(turn("second"));
    const taken = useQueuedTurnsStore.getState().takeNext("s1");

    useQueuedTurnsStore.getState().requeueFirst(taken!);
    expect(useQueuedTurnsStore.getState().queue.map((entry) => entry.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("lets the user take one back", () => {
    const store = useQueuedTurnsStore.getState();
    store.enqueue(turn("keep"));
    store.enqueue(turn("cancel"));

    useQueuedTurnsStore.getState().remove("cancel");
    expect(useQueuedTurnsStore.getState().queue.map((entry) => entry.id)).toEqual(["keep"]);
  });

  it("clears a session on interrupt without touching another", () => {
    const store = useQueuedTurnsStore.getState();
    store.enqueue(turn("mine", "s1"));
    store.enqueue(turn("theirs", "s2"));

    useQueuedTurnsStore.getState().clearSession("s1");
    expect(useQueuedTurnsStore.getState().queue.map((entry) => entry.id)).toEqual(["theirs"]);
  });
});

describe("queuedTurnsForThread", () => {
  it("returns one stable empty array, so an idle composer never re-renders", () => {
    // zustand compares the selected value by identity; a fresh [] per read
    // would make every queue change re-render every thread on screen.
    expect(queuedTurnsForThread([], "t1")).toBe(EMPTY_QUEUE);
    expect(queuedTurnsForThread([turn("a")], "other")).toBe(EMPTY_QUEUE);
    expect(queuedTurnsForThread([turn("a")], null)).toBe(EMPTY_QUEUE);
  });

  it("narrows to the thread asking", () => {
    const queue = [turn("a", "s1", "t1"), turn("b", "s2", "t2"), turn("c", "s1", "t1")];
    expect(queuedTurnsForThread(queue, "t1").map((entry) => entry.id)).toEqual(["a", "c"]);
  });
});
