import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createSocketHost, defaultLoopHost } from "./transport.ts";

/** Just enough of a WebSocket to see what a host dials and sends. */
class FakeSocket {
  static opened: FakeSocket[] = [];
  readonly sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string): void {
    const message = JSON.parse(raw);
    this.sent.push(message);
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { from: this.url } }),
      }),
    );
  }

  notify(method: string, params: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  }

  close(): void {
    this.onclose?.();
  }
}

const globals = globalThis as { WebSocket?: unknown };
let realWebSocket: unknown;

beforeEach(() => {
  FakeSocket.opened = [];
  realWebSocket = globals.WebSocket;
  globals.WebSocket = FakeSocket;
});

afterEach(() => {
  globals.WebSocket = realWebSocket;
  vi.useRealTimers();
});

describe("createSocketHost", () => {
  it("answers each call from its own machine", async () => {
    const mac = createSocketHost("mac", "ws://mac:5667/ws?token=a");
    const devbox = createSocketHost("devbox", "ws://devbox:5667/ws?token=b");

    expect(await mac.call("server.info")).toEqual({ from: "ws://mac:5667/ws?token=a" });
    expect(await devbox.call("server.info")).toEqual({ from: "ws://devbox:5667/ws?token=b" });
    expect(FakeSocket.opened.map((socket) => socket.url)).toEqual([
      "ws://mac:5667/ws?token=a",
      "ws://devbox:5667/ws?token=b",
    ]);
  });

  it("sends the project folder as a parameter", async () => {
    const host = createSocketHost("mac", "ws://mac/ws");
    await host.call("catalog.list", {}, "/work/app");
    expect(FakeSocket.opened[0]!.sent[0]).toMatchObject({
      method: "catalog.list",
      params: { cwd: "/work/app" },
    });
  });

  it("delivers a host's session events only to that host's listeners", async () => {
    const mac = createSocketHost("mac", "ws://mac/ws");
    const devbox = createSocketHost("devbox", "ws://devbox/ws");
    const seenOnMac: unknown[] = [];
    const seenOnDevbox: unknown[] = [];
    mac.onEvent((event) => seenOnMac.push(event.sessionId));
    devbox.onEvent((event) => seenOnDevbox.push(event.sessionId));

    FakeSocket.opened[0]!.notify("session.event", { sessionId: "s1", seq: 1, part: {} });

    expect(seenOnMac).toEqual(["s1"]);
    expect(seenOnDevbox).toEqual([]);
  });

  it("never redials a one-use URL, and fails calls after it drops", async () => {
    vi.useFakeTimers();
    const host = createSocketHost("paired", "ws://mac/ws?wsTicket=once", { reconnect: false });
    const states: string[] = [];
    host.onConnectionChange((state) => states.push(state));
    await host.call("server.info");
    expect(FakeSocket.opened).toHaveLength(1);

    FakeSocket.opened[0]!.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeSocket.opened).toHaveLength(1);
    expect(states.at(-1)).toBe("closed");
    await expect(host.call("server.info")).rejects.toThrow(/not connected/);
  });

  it("stops redialing once closed", async () => {
    vi.useFakeTimers();
    const host = createSocketHost("mac", "ws://mac/ws");
    host.onEvent(() => {});
    expect(FakeSocket.opened).toHaveLength(1);

    host.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeSocket.opened).toHaveLength(1);
  });
});

describe("defaultLoopHost", () => {
  it("is inert in a shell with no page to dial", async () => {
    // The unit environment has neither `window.loop` nor a `location`, which
    // is exactly the mobile app's position.
    expect(globalThis.location).toBeUndefined();
    expect(() => defaultLoopHost.onEvent(() => {})).not.toThrow();
    expect(defaultLoopHost.filesystem()).toBeNull();
    await expect(defaultLoopHost.call("server.info")).rejects.toThrow(/no default loop host/);
    expect(FakeSocket.opened).toHaveLength(0);
  });
});
