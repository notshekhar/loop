/**
 * The workspace host: git, terminals and the filesystem, in their own process.
 *
 * Entry point for an Electron `utilityProcess` — a real Node process, which is
 * what makes it the right home for node-pty (a native addon a worker thread
 * cannot be trusted with) and for anything that spawns.
 *
 * The reason it exists is measured rather than aesthetic. `uv_spawn` blocks the
 * thread that calls it, and every one of these capabilities spawns: a diff
 * fanning out across a workspace, `gh`, a login shell. In the main process
 * those blocked the thread running loop's core, so opening the diff panel
 * mid-turn stalled the agent. Here they block only this process, whose job is
 * to be blocked.
 *
 * PTY output no longer competes with the agent for a thread either — though it
 * still passes through main on its way to the renderer. Handing the renderer a
 * MessagePort would remove even that hop; it is deliberately not done here,
 * because it changes the preload's contract and this change does not.
 */
import * as pty from "node-pty";
import { createHostHandlers, HOST_CHANNELS, type PtyProcess, type PtySpawner } from "@notshekhar/loop-core/workspace";
import type { FromHost, HostCallbackResponse, ToHost } from "./hostProtocol.js";

/**
 * `parentPort` is present only under `utilityProcess.fork`.
 *
 * Typed locally rather than imported: `electron`'s types describe the main
 * process, and this file is bundled for Node. A missing port means someone ran
 * this directly, which is worth failing loudly over — silently doing nothing
 * would look like a host that started and answered nothing.
 */
/** The renderer end of the direct terminal pipe, once main has handed it over. */
interface DirectPort {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

interface ParentPort {
  on(event: "message", listener: (message: { data: ToHost; ports: DirectPort[] }) => void): void;
  postMessage(message: FromHost): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  throw new Error("the workspace host must be started with utilityProcess.fork");
}
const port = parentPort;

let nextCallbackId = 1;
const pendingCallbacks = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

/**
 * The direct pipe to the renderer, when there is one.
 *
 * Terminal output goes down this and nothing else does, so main is out of the
 * hot path without any of the other channels changing. Strictly either/or per
 * event — never both — so the two roads cannot deliver the same bytes twice.
 *
 * Null until main hands one over, and again if a renderer reload invalidates
 * it, in which case output falls back to the notification road. Main wires this
 * up at window creation, before the renderer can ask for a terminal, so in
 * practice nothing is written before the pipe exists.
 */
let directPort: DirectPort | null = null;

/** node-pty: this process runs under Electron's Node, where its callbacks fire. */
const spawnPty: PtySpawner = (input) =>
  pty.spawn(input.shell, [...input.args], {
    name: "xterm-256color",
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env,
  }) as unknown as PtyProcess;

const { handlers, terminals } = createHostHandlers({
  spawnPty,
  notify: (channel, payload) => {
    if (channel === HOST_CHANNELS.terminal && directPort) {
      directPort.postMessage(payload);
      return;
    }
    port.postMessage({ kind: "notify", channel, payload });
  },
  callback: (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextCallbackId++;
      pendingCallbacks.set(id, { resolve, reject });
      port.postMessage({ kind: "callback", id, method, params });
    }),
});

function settleCallback(message: HostCallbackResponse): void {
  const pending = pendingCallbacks.get(message.id);
  if (!pending) return;
  pendingCallbacks.delete(message.id);
  if (message.ok) pending.resolve(message.value);
  else pending.reject(new Error(message.error ?? "the main process could not answer"));
}

port.on("message", ({ data, ports }) => {
  if (data.kind === "port") {
    // A new pipe replaces the old one; the previous renderer is gone and its
    // end is dead, so holding it open would leak a port per reload.
    directPort?.close();
    const next = ports[0] ?? null;
    next?.start();
    directPort = next;
    return;
  }
  if (data.kind === "callbackResponse") {
    settleCallback(data);
    return;
  }
  const handler = handlers[data.method];
  if (!handler) {
    port.postMessage({
      kind: "response",
      id: data.id,
      ok: false,
      error: `the workspace host has no method ${data.method}`,
    });
    return;
  }
  // Awaited inside a promise so a handler that throws synchronously becomes a
  // failed response rather than an unhandled rejection that takes the host down
  // and every terminal with it.
  void (async () => {
    try {
      const value = await handler((data.params ?? {}) as Record<string, unknown>);
      port.postMessage({ kind: "response", id: data.id, ok: true, value });
    } catch (error) {
      port.postMessage({
        kind: "response",
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});

// A host that is going away should not leave orphaned shells behind holding
// the user's project directories open.
process.on("exit", () => terminals.closeAll());
