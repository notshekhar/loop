/**
 * The client's copy of a session's transcript: the host snapshot plus every
 * later event, each applied once. These pin the ordering that makes it exact —
 * the guarantees the old history/live merge kept getting wrong.
 */
import { describe, expect, it } from "vite-plus/test";

import type { LoopEvent, LoopHost } from "../transport.ts";
import { forgetTranscriptsForTests, readTranscript, watchTranscript } from "./store.ts";

type Part = { type: string; data?: unknown };

function fakeHost(snapshot: () => { messages: unknown[]; seq: number; running?: boolean }) {
  const eventListeners = new Set<(event: LoopEvent) => void>();
  const connectionListeners = new Set<(state: "open" | "closed" | "connecting") => void>();
  const calls: string[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const host = {
    id: `host-${Math.random()}`,
    call: async (method: string) => {
      calls.push(method);
      if (method === "session.messages") {
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        return { ...snapshot(), todos: [] };
      }
      return {};
    },
    onEvent: (listener: (event: LoopEvent) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onConnectionChange: (listener: (state: "open" | "closed" | "connecting") => void) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    filesystem: () => null,
    pty: () => null,
    git: () => null,
    shell: () => null,
    sourceControl: () => null,
  } as unknown as LoopHost;
  return {
    host,
    calls,
    emit: (sessionId: string, seq: number, part: Part) => {
      for (const listener of eventListeners) listener({ sessionId, seq, part } as LoopEvent);
    },
    reconnect: () => {
      for (const listener of connectionListeners) listener("open");
    },
    holdSnapshot: () => {
      hold = true;
    },
    releaseSnapshot: () => {
      hold = false;
      release?.();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const texts = (host: LoopHost, sessionId: string) =>
  readTranscript(host, sessionId).transcript.messages.flatMap((message) =>
    message.parts.map((part) => (part.type === "text" ? `${message.role}:${part.text}` : part.type)),
  );

const userMessage = (id: string, text: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text, state: "done" }],
  metadata: { createdAt: 1 },
});

describe("the transcript a client holds", () => {
  it("subscribes, then snapshots, then applies only what came after the snapshot", async () => {
    const fake = fakeHost(() => ({ messages: [userMessage("u1", "hi")], seq: 5, running: true }));
    const stop = watchTranscript(fake.host, "s1", () => {});
    await settle();
    expect(fake.calls.indexOf("session.attach")).toBeLessThan(fake.calls.indexOf("session.messages"));

    fake.emit("s1", 5, { type: "text-delta", data: "already in the snapshot" });
    fake.emit("s1", 6, { type: "text-delta", data: "Hello" });
    expect(texts(fake.host, "s1")).toEqual(["user:hi", "assistant:Hello"]);
    stop();
    forgetTranscriptsForTests();
  });

  it("keeps an event that arrives while the snapshot is in flight, exactly once", async () => {
    let seq = 1;
    const fake = fakeHost(() => ({ messages: [userMessage("u1", "hi")], seq, running: true }));
    fake.holdSnapshot();
    const stop = watchTranscript(fake.host, "s2", () => {});
    await settle();
    // Lands before the snapshot answers — and the snapshot does not include it.
    fake.emit("s2", 2, { type: "text-delta", data: "early " });
    fake.releaseSnapshot();
    await settle();
    fake.emit("s2", 3, { type: "text-delta", data: "late" });
    // A replay of what already arrived is not applied twice.
    fake.emit("s2", 2, { type: "text-delta", data: "early " });
    expect(texts(fake.host, "s2")).toEqual(["user:hi", "assistant:early late"]);
    seq = 3;
    stop();
    forgetTranscriptsForTests();
  });

  it("takes a fresh snapshot after a reconnect, even from a host that numbers from 1 again", async () => {
    let state = { messages: [userMessage("u1", "before")], seq: 40 };
    const fake = fakeHost(() => state);
    const stop = watchTranscript(fake.host, "s3", () => {});
    await settle();
    expect(texts(fake.host, "s3")).toEqual(["user:before"]);

    // The host restarted: a new counter, and the session as it now stands.
    state = { messages: [userMessage("u1", "before"), userMessage("u2", "after")], seq: 0 };
    fake.reconnect();
    await settle();
    fake.emit("s3", 1, { type: "text-delta", data: "streaming again" });
    expect(texts(fake.host, "s3")).toEqual(["user:before", "user:after", "assistant:streaming again"]);
    stop();
    forgetTranscriptsForTests();
  });

  it("ignores other sessions' events", async () => {
    const fake = fakeHost(() => ({ messages: [], seq: 0 }));
    const stop = watchTranscript(fake.host, "mine", () => {});
    await settle();
    fake.emit("someone-else", 1, { type: "text-delta", data: "not mine" });
    expect(texts(fake.host, "mine")).toEqual([]);
    stop();
    forgetTranscriptsForTests();
  });
});
