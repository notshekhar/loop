/**
 * loop's desktop shell.
 *
 * Deliberately small. Upstream's Electron app is 131 files of Clerk auth,
 * tailscale, SSH, WSL and an auto-updater; none of that is loop's, so this is
 * written rather than forked. It does three things: open a window, keep one
 * `loop rpc` child alive, and pipe JSON-RPC between the two.
 *
 * This file only wires the parts together; each lives in `window/` or `ipc/`.
 */
import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setCodeModeRuntime } from "@notshekhar/loop-core/code-mode-location";

import { CoreHost } from "./coreHost.js";
import { LoopProcess, resolveLoopBinary } from "./loopProcess.js";
import { HostClient, type HostProcess } from "./hostClient.js";
import { HOST_CALLBACKS, TERMINAL_PORT_CHANNEL } from "./hostProtocol.js";
import { PreviewManager } from "./preview.js";
import { connectHost } from "./ipc/hostBridge.js";
import { connectLoop } from "./ipc/loopBridge.js";
import { connectPreviews } from "./ipc/previews.js";
import { connectUpdates } from "./ipc/updates.js";
import { keepPreviewLinksInPanel, MainWindow } from "./window/mainWindow.js";
import { handleRendererScheme, registerRendererScheme } from "./window/rendererProtocol.js";

registerRendererScheme();

/**
 * Paths are resolved from Electron's app root, not from this file.
 *
 * MEASURED: neither of the usual handles survives bundling here. Bun rewrites
 * `__dirname` in its CommonJS output to the **source** directory (`src/`), and
 * `import.meta.url` to the package root — so a path built from either was one
 * level off, and the preload plus every renderer asset 404'd with an error that
 * pointed at a plausible-looking wrong directory.
 *
 * `app.getAppPath()` is the directory holding this package's package.json in
 * development and the asar root once packaged, which is exactly what `dist/`
 * hangs off in both cases.
 */
const distDirectory = join(app.getAppPath(), "dist");
/** Laid down by build.ts. */
const rendererDirectory = resolve(distDirectory, "renderer");
const preloadPath = resolve(distDirectory, "preload", "index.cjs");
/** The workspace host's entry, forked as a utility process. Same trap as above. */
const hostPath = resolve(distDirectory, "host", "index.cjs");
/**
 * Code Mode's worker and wasm (build.ts), for the core running in this
 * process. Once packaged they are unpacked beside the archive (package-app.ts),
 * and a worker has to be started from that real file, not the asar path.
 */
const codeModeDirectory = resolve(distDirectory.replace(/app\.asar(?=[\\/]|$)/, "app.asar.unpacked"), "codemode");
/** The window icon, copied into dist alongside the renderer by `build.ts`. */
const appIconPath = resolve(distDirectory, "icon.png");

/**
 * Where loop actually runs.
 *
 * Default: **in this process**, with core imported as the library it is. The
 * old path — spawn the compiled `loop rpc` binary and talk JSON-RPC over its
 * stdio — is still here and one env var away, because it is the fallback if
 * anything about running core under Electron's Node turns out to be wrong on
 * a machine this has not been tried on.
 *
 * `LOOP_SPAWN_BINARY=1` picks the child process. `LOOP_BINARY` still names
 * which binary that would be.
 *
 * Both satisfy the same tiny interface (`call` / `start` / `stop` / `running`
 * plus the three events), so nothing below this line knows which is in use —
 * and neither does the renderer.
 */
const anchorCwd = process.env["LOOP_ANCHOR_CWD"] ?? homedir();
const spawnBinary = process.env["LOOP_SPAWN_BINARY"] === "1";
const loopBinary = resolveLoopBinary(process.env["LOOP_BINARY"], app.getAppPath());
/**
 * The binary core runs as bun (`BUN_BE_BUN=1`) to install and launch language
 * servers. Under the CLI that is `process.execPath`; here that is this app, and
 * spawning it opened a second copy instead (core's bun-binary.ts). The loop
 * binary is the same runtime the CLI uses, so it does the job unchanged.
 */
if (existsSync(loopBinary)) process.env["LOOP_BUN_BINARY"] ??= loopBinary;
if (!spawnBinary) {
  setCodeModeRuntime({
    workerUrl: pathToFileURL(join(codeModeDirectory, "worker.cjs")),
    wasmPath: join(codeModeDirectory, "quickjs.wasm"),
  });
}
const loop = spawnBinary
  ? new LoopProcess({ binary: loopBinary, cwd: anchorCwd })
  : new CoreHost({ cwd: anchorCwd });

/**
 * git, terminals and the filesystem, in a process of their own.
 *
 * They used to run here. `uv_spawn` blocks the thread that calls it, and all
 * three spawn constantly — a workspace diff forks per repository, a shell pumps
 * a build log — so they stalled the thread running loop's core and the agent
 * turn on it. None of those modules imports `electron`, which is what let them
 * move without being rewritten.
 *
 * The commit-message callback is the one thing that still has to come back
 * here: loop owns the models and core runs in this process.
 */
const host = new HostClient(
  () =>
    utilityProcess.fork(hostPath, [], {
      // Named so it is identifiable in Activity Monitor rather than being a
      // second anonymous "Electron Helper" nobody can account for.
      serviceName: "loop workspace host",
      stdio: "pipe",
    }) as unknown as HostProcess,
  {
    [HOST_CALLBACKS.commitMessage]: (params) => loop.call("git.commitMessage", params),
  },
);
const previews = new PreviewManager();
const mainWindow = new MainWindow({
  preloadPath,
  iconPath: appIconPath,
  onLoad: connectTerminalPort,
});
const forward = (channel: string, payload: unknown) => mainWindow.forward(channel, payload);

/**
 * Give the host a pipe straight to the renderer, for terminal output.
 *
 * Every PTY byte used to arrive here purely to be handed on — main read it,
 * re-serialised it and forwarded it, adding nothing. A transferred
 * MessagePort removes that hop: the host writes and the renderer reads, with
 * this process not involved.
 *
 * Called whenever either end is replaced, because a port is only valid for the
 * pair that holds it. A renderer reload kills the far end; a host restart kills
 * the near one. Both re-run this, and the host closes the port it was holding
 * before taking the new one, so reloading in a loop cannot leak ports.
 */
function connectTerminalPort(): void {
  const target = mainWindow.current;
  if (!target || !host.running) return;
  const { port1, port2 } = new MessageChannelMain();
  host.transferPort(port1);
  target.webContents.postMessage(TERMINAL_PORT_CHANNEL, null, [port2]);
}

/**
 * One loop per profile.
 *
 * Nothing enforced this, so launching the app again — from the Dock, from
 * Spotlight, or by an agent running `open -a Loop` — started a whole second
 * copy: two dock icons, and underneath them two cores serving RPC, two sets of
 * PTYs drawing on the same system-wide pty pool, and two processes writing the
 * same `agent.db`. The duplicate icon is the visible half; sharing a SQLite
 * database between two writers is the half that matters.
 *
 * Electron keys this lock on the user-data directory, so a deliberate second
 * profile (`--user-data-dir`, which is how the app is driven under test) is
 * still free to run alongside. Only accidental duplicates of the same install
 * are refused.
 *
 * Everything at module scope so far is inert — `CoreHost`'s constructor only
 * records a cwd — so quitting here starts nothing that needs unwinding.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

app.whenReady().then(() => {
  // `quit()` above is not immediate; without this the loser of the race would
  // still spin up a core and a window before the process went away.
  if (!gotSingleInstanceLock) return;
  handleRendererScheme(rendererDirectory);
  app.on("web-contents-created", (_event, contents) => keepPreviewLinksInPanel(contents));

  connectLoop(loop, forward, spawnBinary ? loopBinary : "in-process core");
  connectHost(host, forward, connectTerminalPort);
  connectUpdates(forward);
  connectPreviews(previews, forward);

  // Asked once on mount, because a reload mid-fullscreen would otherwise wait
  // for a transition that already happened.
  ipcMain.handle("loop:window.isFullscreen", () => mainWindow.isFullScreen());
  ipcMain.handle("loop:window.isFocused", () => mainWindow.isFocused());

  mainWindow.open();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow.open();
  });
  app.on("second-instance", () => mainWindow.reveal());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Killing the host takes its shells with it — they are its children — but
  // asking first gives each one a chance to die cleanly rather than being
  // orphaned mid-write.
  void host.call("pty.closeAll").catch(() => {});
  host.stop();
  previews.disposeAll();
  loop.stop();
});
