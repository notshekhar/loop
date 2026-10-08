import type { ClientOrchestrationCommand } from "@loop/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { LoopEvent, LoopFilesystemBridge, LoopHost } from "../transport.ts";
import { dispatchCommand } from "./dispatch.ts";
import { readLiveTurn, subscribeLiveTurns } from "./liveTurn.ts";
import { buildShellSnapshot } from "./shell.ts";

/**
 * One app, two machines: everything a handler does for one host has to reach
 * that host and no other. The mobile app's host list and a browser tab with a
 * second machine added both rest on this.
 */

interface FakeHost extends LoopHost {
  readonly calls: { method: string; params: unknown }[];
  emit(event: LoopEvent): void;
}

function fakeHost(id: string, sessions: readonly { id: string; cwd: string }[] = []): FakeHost {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Set<(event: LoopEvent) => void>();
  const fs: LoopFilesystemBridge = {
    list: () => Promise.reject(new Error("unused")),
    read: () => Promise.reject(new Error("unused")),
    browse: (partialPath) =>
      Promise.resolve({ parentPath: partialPath.replace(/\/$/, ""), entries: [] }),
  };
  return {
    id,
    calls,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "session.create") return Promise.resolve({ sessionId: `${id}-session` } as T);
      if (method === "session.list") {
        return Promise.resolve(
          sessions.map((session) => ({
            id: session.id,
            cwd: session.cwd,
            createdAt: 1,
            mtime: 1,
            messageCount: 1,
          })) as T,
        );
      }
      return Promise.resolve({} as T);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConnectionChange: () => () => {},
    filesystem: () => fs,
    pty: () => null,
    git: () => null,
    shell: () => null,
    sourceControl: () => null,
  };
}

const command = (fields: Record<string, unknown>) =>
  ({
    commandId: `cmd-${String(fields.type)}`,
    createdAt: "2026-10-07T00:00:00.000Z",
    ...fields,
  }) as unknown as ClientOrchestrationCommand;

const modelSelection = { instanceId: "kimi", model: "kimi/k3" };

describe("several hosts in one app", () => {
  it("sends each thread's turn to the host it was created on", async () => {
    const mac = fakeHost("mac");
    const devbox = fakeHost("devbox");

    for (const [host, threadId] of [
      [mac, "thread-mac"],
      [devbox, "thread-devbox"],
    ] as const) {
      await Effect.runPromise(
        dispatchCommand(
          command({
            type: "thread.create",
            threadId,
            projectId: "/work/app",
            title: "New thread",
            modelSelection,
          }),
          host,
        ),
      );
      await Effect.runPromise(
        dispatchCommand(
          command({
            type: "thread.turn.start",
            threadId,
            message: { messageId: `m-${host.id}`, text: `hi ${host.id}` },
            modelSelection,
          }),
          host,
        ),
      );
    }

    const sends = (host: FakeHost) =>
      host.calls.filter((call) => call.method === "session.send").map((call) => call.params);
    expect(sends(mac)).toEqual([expect.objectContaining({ sessionId: "mac-session", input: "hi mac" })]);
    expect(sends(devbox)).toEqual([
      expect.objectContaining({ sessionId: "devbox-session", input: "hi devbox" }),
    ]);
  });

  it("keeps a folder added on one host out of the other host's projects", async () => {
    const mac = fakeHost("mac-projects");
    const devbox = fakeHost("devbox-projects");

    await Effect.runPromise(
      dispatchCommand(
        command({
          type: "project.create",
          projectId: "01ADDEDONMAC",
          title: "fresh",
          workspaceRoot: "/Users/me/fresh",
        }),
        mac,
      ),
    );

    const projectsOf = async (host: FakeHost) =>
      (await Effect.runPromise(buildShellSnapshot(false, host))).projects.map(
        (project) => project.workspaceRoot,
      );
    expect(await projectsOf(mac)).toContain("/Users/me/fresh");
    expect(await projectsOf(devbox)).not.toContain("/Users/me/fresh");
  });

  it("applies turn events from every subscribed host", () => {
    const mac = fakeHost("mac-events");
    const devbox = fakeHost("devbox-events");
    subscribeLiveTurns(mac);
    subscribeLiveTurns(devbox);

    mac.emit({ sessionId: "s-mac", seq: 1, part: { type: "text-delta", data: "from mac" } });
    devbox.emit({ sessionId: "s-devbox", seq: 1, part: { type: "text-delta", data: "from devbox" } });

    expect(readLiveTurn("s-mac")?.texts.map((run) => run.text).join("")).toBe("from mac");
    expect(readLiveTurn("s-devbox")?.texts.map((run) => run.text).join("")).toBe("from devbox");
  });

  it("subscribes to a host once however often it is asked", () => {
    const mac = fakeHost("mac-once");
    let subscriptions = 0;
    const counting: LoopHost = {
      ...mac,
      onEvent: (listener) => {
        subscriptions += 1;
        return mac.onEvent(listener);
      },
    };
    subscribeLiveTurns(counting);
    subscribeLiveTurns(counting);
    expect(subscriptions).toBe(1);
  });
});
