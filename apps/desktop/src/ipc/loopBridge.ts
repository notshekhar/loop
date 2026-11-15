/** loop's core ↔ the renderer: its events out, `loop:call` in, and a restart when a child dies. */
import { ipcMain } from "electron";

import type { CoreHost } from "../coreHost.js";
import type { LoopProcess } from "../loopProcess.js";

/** Both run loop and look the same from here — in-process core, or a spawned `loop rpc`. */
export type Loop = CoreHost | LoopProcess;
export type Forward = (channel: string, payload: unknown) => void;

/** Wire loop's events, start it, and answer the renderer's calls. `label` names which loop runs. */
export function connectLoop(loop: Loop, forward: Forward, label: string): void {
  loop.on("notification", (message) => forwardNotification(message, forward));
  loop.on("stderr", (line) => {
    // loop's own diagnostics belong in the shell's log, not swallowed.
    console.error(`[loop] ${line}`);
  });
  // Only a spawned binary can exit on its own; in-process core never emits
  // this, so the restart path is simply never armed.
  loop.on("exit", (code) => {
    console.error(`[loop] exited with ${code ?? "signal"}; restarting`);
    forward("loop:status", { running: false });
    // A crashed agent should not take the window with it.
    setTimeout(() => {
      loop.start();
      forward("loop:status", { running: loop.running });
    }, 1000);
  });
  // Which loop is running is the first thing to know when an RPC 404s, and it
  // is invisible otherwise — bundled and installed binaries look identical
  // from the renderer.
  console.error(`[loop] running: ${label}`);
  loop.start();
  handleLoopCall(loop);
}

function forwardNotification(message: { method: string; params: unknown }, forward: Forward): void {
  if (message.method === "session.event") forward("loop:event", message.params);
  // Host-wide news — a session created, renamed, started or stopped
  // somewhere, a thread team moving — in the shape the WebSocket transport
  // gives it (apps/web loop/transport.ts): a `session-status` part with no
  // seq. Dropped here before, the desktop learned of a session another part
  // of the app created (a team's threads) only on its next unrelated
  // refresh, and a team panel opened on a draft never heard its team begin.
  if (message.method === "session.status") {
    const status = message.params as { sessionId?: unknown } | undefined;
    if (typeof status?.sessionId !== "string") return;
    forward("loop:event", {
      sessionId: status.sessionId,
      seq: 0,
      part: { type: "session-status", data: status },
    });
  }
}

/**
 * Answers in an envelope rather than by throwing, and the preload unwraps it.
 *
 * An RPC error here is an ordinary outcome of the protocol, not a fault:
 * "Unknown sessionId" for a conversation that was deleted, "Method not
 * found" against an older loop, "a turn is already running". The renderer
 * handles all three. But a handler that REJECTS makes Electron print
 * `Error occurred in handler for 'loop:call'` with a full stack to the
 * main-process log every single time — so an app that was working correctly
 * read as one that was crashing.
 *
 * The envelope keeps the error (the renderer still throws, see preload.ts)
 * and drops the noise.
 */
function handleLoopCall(loop: Loop): void {
  ipcMain.handle("loop:call", async (_event, payload: { method: string; params: unknown }) => {
    try {
      return { ok: true as const, value: await loop.call(payload.method, payload.params) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
