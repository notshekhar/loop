/**
 * In-app updates.
 *
 * Only for a packaged build: `app.isPackaged` is false when running from the
 * repo, and there "replace the install directory" would mean renaming a
 * checkout out from under the developer. Disabled is a state the pill already
 * understands, so it simply does not appear.
 */
import { app, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";

import { UpdateManager } from "../updateManager.js";
import type { Arch, Platform } from "../updater.js";
import type { Forward } from "./loopBridge.js";

/** Delayed so the first check never competes with the window's first paint. */
const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function connectUpdates(forward: Forward): void {
  const updates = createUpdateManager();
  updates.on("state", (state) => forward("loop:update.state", state));
  handleUpdateCalls(updates);
  if (app.isPackaged) {
    setTimeout(() => void updates.check(), FIRST_CHECK_DELAY_MS);
    setInterval(() => void updates.check(), CHECK_INTERVAL_MS);
  }
}

function createUpdateManager(): UpdateManager {
  return new UpdateManager({
    currentVersion: app.getVersion(),
    platform: process.platform as Platform,
    arch: process.arch === "arm64" ? "arm64" : ("x64" as Arch),
    execPath: process.execPath,
    enabled: app.isPackaged,
    run: runToCompletion,
    // Detached and unref'd, or the helper dies with the process it is waiting for.
    spawnDetached: (command, args) => {
      spawn(command, [...args], { detached: true, stdio: "ignore" }).unref();
    },
    restart: relaunch,
  });
}

function runToCompletion(command: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.on("error", rejectRun);
    child.on("exit", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited ${code}`)),
    );
  });
}

/**
 * Leave, and come back as the new copy.
 *
 * `null` means quit and nothing else — the Windows helper relaunches us
 * itself, and doing it here too would re-lock the install directory it is
 * waiting to move.
 *
 * On macOS the relaunch goes through `/usr/bin/open` rather than a bare
 * `app.relaunch()`. Electron's default relaunch execs the inner Mach-O
 * (`Loop.app/Contents/MacOS/Loop`) directly, which is a launch macOS never
 * performs itself: the bundle has just been replaced on disk, and starting
 * the executable behind LaunchServices' back is what leaves the app quit
 * with nothing coming back. `open -n -a` asks macOS to launch the bundle
 * the way a double-click does, so the new copy is registered, activated
 * and given its dock icon.
 */
function relaunch(relaunchFrom: string | null): void {
  if (relaunchFrom !== null) {
    if (process.platform === "darwin") {
      app.relaunch({ execPath: "/usr/bin/open", args: ["-n", "-a", relaunchFrom] });
    } else {
      app.relaunch();
    }
  }
  app.quit();
}

function handleUpdateCalls(updates: UpdateManager): void {
  ipcMain.handle("loop:update.state", () => updates.state);
  // `checked` comes from the manager rather than being hardcoded true: a
  // manual check has to be able to say "nothing happened" (build without
  // updates, or a check already running) instead of looking like a no-op.
  ipcMain.handle("loop:update.check", async () => await updates.check());
  ipcMain.handle("loop:update.download", async () => {
    const state = await updates.download();
    return { accepted: true, completed: state.status === "downloaded", state };
  });
  ipcMain.handle("loop:update.openExternal", (_event, p: { url: string }) => openReleaseNotes(p.url));
  ipcMain.handle("loop:update.install", async () => {
    const state = await updates.install();
    return { accepted: true, completed: false, state };
  });
}

/**
 * Open a link in the real browser, for the update toast's release notes.
 *
 * Restricted to http(s): this is reachable from the renderer, and handing an
 * arbitrary string to the OS opener is how a `file:` or custom-scheme URL
 * turns into launching something local.
 */
async function openReleaseNotes(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    await shell.openExternal(parsed.toString());
    return true;
  } catch {
    return false;
  }
}
