/** The workspace host ↔ the renderer: its methods in, its notifications out. */
import { ipcMain } from "electron";

import type { HostClient } from "../hostClient.js";
import type { Forward } from "./loopBridge.js";

/**
 * Everything the workspace host owns: the filesystem, git, GitHub, editors
 * and PTYs.
 *
 * Each of these was a handler that did the work here. They are forwards now,
 * and deliberately nothing more — the host returns exactly what these used to
 * return, envelopes included, so the renderer cannot tell the difference.
 * Keeping main a pipe is the point: the work that blocks a thread should not
 * be on the thread running loop's core.
 *
 * The channel name and the host method are the same string minus `loop:`, so
 * adding a capability means adding it to `hostHandlers.ts` and listing it
 * here.
 */
const HOST_METHODS = [
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.readAsset",
  "fs.browse",
  "fs.createDirectory",
  "git.discover",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.stageContent",
  "git.conflictStages",
  "git.fileAtRevision",
  "git.refs",
  "git.status",
  "git.watch",
  "git.unwatch",
  "git.init",
  "git.diffPreview",
  "git.runStackedAction",
  "sc.lookup",
  "pr.list",
  "pr.detail",
  "pr.diff",
  "pr.conversation",
  "pr.action",
  "gh.loginStart",
  "gh.loginStatus",
  "gh.loginCancel",
  "gh.loginToken",
  "sc.clone",
  "sc.publish",
  "shell.which",
  "shell.launch",
  "pty.open",
  "pty.snapshot",
  "pty.list",
  "pty.write",
  "pty.resize",
  "pty.clear",
  "pty.close",
] as const;

/** Forward the host's methods and events, then start it. `onReady` runs on every (re)start. */
export function connectHost(host: HostClient, forward: Forward, onReady: () => void): void {
  for (const method of HOST_METHODS) {
    ipcMain.handle(`loop:${method}`, (_event, params: unknown) => host.call(method, params));
  }

  // Terminal output and git-action progress arrive on the host's own schedule;
  // main forwards them by the channel the host names.
  host.on("notify", ({ channel, payload }) => forward(channel, payload));
  host.on("stderr", (line) => console.error(`[host] ${line}`));
  // The shells died with the host. Telling the renderer lets a pane show that
  // rather than sitting on a dead session waiting for bytes.
  host.on("lost", () => forward("loop:terminal.hostLost", {}));
  // A restarted host has no pipe — the old one went with the process that
  // held it — so it gets a fresh one as soon as it is up.
  host.on("ready", onReady);
  host.start();
}
