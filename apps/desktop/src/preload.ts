/**
 * The `window.loop` bridge.
 *
 * This is the exact shape `apps/web/src/loop/transport.ts` looks for, and the
 * only thing the renderer is given: one call, one event subscription, one
 * anchor folder. Node stays on this side of `contextIsolation` — the renderer
 * gets three functions, not a process handle.
 */
import { contextBridge, ipcRenderer } from "electron";

import { TERMINAL_PORT_CHANNEL } from "./hostProtocol.js";

interface LoopEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly part: unknown;
}

/**
 * Turn the main process's `{ok, value|error}` envelope back into a promise
 * that resolves or throws.
 *
 * `loop:call` answers in an envelope so that an ordinary RPC failure — an
 * unknown session, a method an older loop does not have — does not reject
 * inside `ipcMain.handle`, which makes Electron log a stack trace for
 * something the renderer handles perfectly well. The error still reaches the
 * caller; it just no longer looks like a crash. See main.ts.
 *
 * An answer that is not an envelope is passed through, so a build where only
 * one side has been updated still works.
 */
function unwrap(answer: unknown): unknown {
  if (typeof answer !== "object" || answer === null || !("ok" in answer)) return answer;
  const envelope = answer as { ok: boolean; value?: unknown; error?: string };
  if (envelope.ok) return envelope.value;
  throw new Error(envelope.error ?? "loop call failed");
}

const listeners = new Set<(event: LoopEvent) => void>();

ipcRenderer.on("loop:event", (_event, payload: LoopEvent) => {
  for (const listener of listeners) listener(payload);
});

const terminalListeners = new Set<(event: unknown) => void>();
const emitTerminal = (payload: unknown) => {
  for (const listener of terminalListeners) listener(payload);
};

/**
 * Terminal output arrives by whichever road the host has.
 *
 * The direct one is a MessagePort transferred from the workspace host, so PTY
 * bytes reach here without the main process reading and re-forwarding every
 * one of them. The ipc road stays as the fallback for the window before that
 * port is handed over, and for a host that has just restarted without one.
 *
 * The host writes to exactly one of them per event, never both, so feeding a
 * single listener set from both cannot double up. Main re-sends the port on
 * every load, so a reload replaces this rather than accumulating.
 */
ipcRenderer.on("loop:terminal", (_event, payload: unknown) => emitTerminal(payload));

let terminalPort: MessagePort | null = null;
ipcRenderer.on(TERMINAL_PORT_CHANNEL, (event) => {
  terminalPort?.close();
  const port = event.ports[0] ?? null;
  terminalPort = port;
  if (!port) return;
  port.onmessage = (message) => emitTerminal(message.data);
  port.start();
});

/**
 * Whether loop's core is up, so the renderer can re-subscribe when it comes back.
 *
 * main restarts a crashed core and announces it on this channel, but nothing
 * received it: the payload stopped at the preload boundary. loop tracks event
 * subscribers per transport, so the attach belonging to the dead core is gone
 * and nothing re-attached — the thread went permanently silent, turns ran to
 * completion with the transcript frozen, and only a reload brought it back.
 * Forwarding it is what lets `onLoopConnectionChange` do its job here.
 */
const statusListeners = new Set<(running: boolean) => void>();
ipcRenderer.on("loop:status", (_event, payload: { running?: boolean }) => {
  for (const listener of statusListeners) listener(payload?.running === true);
});

const updateStateListeners = new Set<(state: unknown) => void>();
ipcRenderer.on("loop:update.state", (_event, state: unknown) => {
  for (const listener of updateStateListeners) listener(state);
});

const gitChangeListeners = new Set<(event: { cwd: string }) => void>();
ipcRenderer.on("loop:gitChanged", (_event, payload: { cwd: string }) => {
  for (const listener of gitChangeListeners) listener(payload);
});

const gitActionListeners = new Set<(event: unknown) => void>();
ipcRenderer.on("loop:gitAction", (_event, payload: unknown) => {
  for (const listener of gitActionListeners) listener(payload);
});

const focusListeners = new Set<(focused: boolean) => void>();
ipcRenderer.on("loop:window.focus", (_event, focused: boolean) => {
  for (const listener of focusListeners) listener(focused);
});

const fullscreenListeners = new Set<(fullscreen: boolean) => void>();
ipcRenderer.on("loop:fullscreen", (_event, fullscreen: boolean) => {
  for (const listener of fullscreenListeners) listener(fullscreen);
});

const previewStateListeners = new Set<(tabId: string, state: unknown) => void>();
ipcRenderer.on("loop:preview.state", (_event, state: { tabId: string }) => {
  for (const listener of previewStateListeners) listener(state.tabId, state);
});

const previewFrameListeners = new Set<(frame: unknown) => void>();
ipcRenderer.on("loop:preview.frame", (_event, frame: unknown) => {
  for (const listener of previewFrameListeners) listener(frame);
});

/**
 * Operations the browser panel offers but loop's shell does not implement.
 *
 * A missing method would be a `TypeError` deep inside the panel; this is the
 * same refusal said in a sentence the toast can show. See preview.ts for what
 * is and is not wired.
 */
function unsupported(what: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${what} isn't supported in loop's desktop app yet.`));
}

contextBridge.exposeInMainWorld("loop", {
  call(method: string, params: unknown, cwd: string | undefined): Promise<unknown> {
    // `cwd` rides as a parameter rather than picking a process: one loop child
    // serves every project, because sessions carry their own cwd.
    const withCwd =
      cwd === undefined ? params : { cwd, ...(params as Record<string, unknown> | undefined) };
    return ipcRenderer.invoke("loop:call", { method, params: withCwd }).then(unwrap);
  },
  onEvent(listener: (event: LoopEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Core up/down, so a view holding a subscription can renew it. */
  onStatus(listener: (running: boolean) => void): () => void {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },
  /**
   * In-app updates, shaped as upstream's `DesktopBridge` update surface.
   *
   * Hung off `window.loop` rather than `window.desktopBridge` for the same
   * reason as `preview`: exposing that name would flip the renderer's
   * `isElectron` and route auth, connection setup and much else down upstream
   * paths this shell has never had. The renderer's update UI already exists and
   * only needs these five methods.
   */
  updater: {
    getUpdateState: () => ipcRenderer.invoke("loop:update.state"),
    checkForUpdate: () => ipcRenderer.invoke("loop:update.check"),
    downloadUpdate: () => ipcRenderer.invoke("loop:update.download"),
    installUpdate: () => ipcRenderer.invoke("loop:update.install"),
    /** For the toast's release-notes link; main refuses anything but http(s). */
    openExternal: (url: string) => ipcRenderer.invoke("loop:update.openExternal", { url }),
    onUpdateState(listener: (state: unknown) => void): () => void {
      updateStateListeners.add(listener);
      return () => updateStateListeners.delete(listener);
    },
  },
  fs: {
    list(cwd: string) {
      return ipcRenderer.invoke("loop:fs.list", { cwd });
    },
    read(cwd: string, relativePath: string) {
      return ipcRenderer.invoke("loop:fs.read", { cwd, relativePath });
    },
    write(cwd: string, relativePath: string, contents: string) {
      return ipcRenderer.invoke("loop:fs.write", { cwd, relativePath, contents });
    },
    readAsset(absolutePath: string) {
      return ipcRenderer.invoke("loop:fs.readAsset", { absolutePath });
    },
    browse(partialPath: string, cwd: string | undefined) {
      return ipcRenderer.invoke("loop:fs.browse", { partialPath, cwd });
    },
    createDirectory(path: string) {
      return ipcRenderer.invoke("loop:fs.createDirectory", { path });
    },
  },
  sourceControl: {
    lookup: (repository: string) => ipcRenderer.invoke("loop:sc.lookup", { repository }),
    /** Pull requests, read through `gh` (core workspace/pullRequests.ts). */
    listPullRequests: (input: { cwd: string; state?: string; involvement?: string; limit?: number }) =>
      ipcRenderer.invoke("loop:pr.list", input),
    pullRequestDetail: (cwd: string, number: number) =>
      ipcRenderer.invoke("loop:pr.detail", { cwd, number }),
    pullRequestDiff: (cwd: string, number: number) => ipcRenderer.invoke("loop:pr.diff", { cwd, number }),
    clone: (input: unknown) => ipcRenderer.invoke("loop:sc.clone", input),
    publish: (input: unknown) => ipcRenderer.invoke("loop:sc.publish", input),
  },
  shell: {
    which: (commands: string[]) => ipcRenderer.invoke("loop:shell.which", { commands }),
    launch: (command: string | null, args: string[], target: string) =>
      ipcRenderer.invoke("loop:shell.launch", { command, args, target }),
  },
  git: {
    refs: (cwd: string) => ipcRenderer.invoke("loop:git.refs", { cwd }),
    status: (cwd: string) => ipcRenderer.invoke("loop:git.status", { cwd }),
    /** Push instead of poll; see core's workspace/gitWatch.ts. */
    watch: (cwd: string, id: string) => ipcRenderer.invoke("loop:git.watch", { cwd, id }),
    unwatch: (id: string) => ipcRenderer.invoke("loop:git.unwatch", { id }),
    onChanged(listener: (event: { cwd: string }) => void): () => void {
      gitChangeListeners.add(listener);
      return () => gitChangeListeners.delete(listener);
    },
    init: (cwd: string) => ipcRenderer.invoke("loop:git.init", { cwd }),
    diffPreview: (cwd: string, options: { baseRef?: string; ignoreWhitespace?: boolean; contextLines?: number }) =>
      ipcRenderer.invoke("loop:git.diffPreview", { cwd, ...options }),
    runStackedAction: (input: unknown) => ipcRenderer.invoke("loop:git.runStackedAction", input),
    discover: () => ipcRenderer.invoke("loop:git.discover"),
    /**
     * Index writes. Each answers with the repository's fresh status, so the
     * panel repaints from what git did rather than predicting it.
     */
    stage: (cwd: string, paths: readonly string[]) =>
      ipcRenderer.invoke("loop:git.stage", { cwd, paths }),
    unstage: (cwd: string, paths: readonly string[]) =>
      ipcRenderer.invoke("loop:git.unstage", { cwd, paths }),
    discard: (cwd: string, input: { tracked?: readonly string[]; untracked?: readonly string[] }) =>
      ipcRenderer.invoke("loop:git.discard", { cwd, ...input }),
    stageContent: (cwd: string, path: string, content: string) =>
      ipcRenderer.invoke("loop:git.stageContent", { cwd, path, content }),
    fileAtRevision: (cwd: string, revision: "HEAD" | "index", path: string) =>
      ipcRenderer.invoke("loop:git.fileAtRevision", { cwd, revision, path }),
    conflictStages: (cwd: string, path: string) =>
      ipcRenderer.invoke("loop:git.conflictStages", { cwd, path }),
    onActionProgress(listener: (event: unknown) => void): () => void {
      gitActionListeners.add(listener);
      return () => gitActionListeners.delete(listener);
    },
  },
  pty: {
    open: (input: unknown) => ipcRenderer.invoke("loop:pty.open", input),
    snapshot: (threadId: string, terminalId: string) =>
      ipcRenderer.invoke("loop:pty.snapshot", { threadId, terminalId }),
    list: () => ipcRenderer.invoke("loop:pty.list"),
    write: (threadId: string, terminalId: string, data: string) =>
      ipcRenderer.invoke("loop:pty.write", { threadId, terminalId, data }),
    resize: (threadId: string, terminalId: string, cols: number, rows: number) =>
      ipcRenderer.invoke("loop:pty.resize", { threadId, terminalId, cols, rows }),
    clear: (threadId: string, terminalId: string) =>
      ipcRenderer.invoke("loop:pty.clear", { threadId, terminalId }),
    close: (threadId: string, terminalId: string | undefined) =>
      ipcRenderer.invoke("loop:pty.close", { threadId, terminalId }),
    onOutput(listener: (event: unknown) => void): () => void {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
  },
  /**
   * The browser panel's half of the webview.
   *
   * Shaped as upstream's `DesktopPreviewBridge` (apps/web/src/loop/contracts/ipc.ts)
   * because that is what the panel calls — but hung off `window.loop`, not
   * `window.desktopBridge`. Exposing the latter would flip the renderer's
   * `isElectron` to true and route auth, connection setup and the update
   * checker through upstream desktop methods this shell has never had.
   */
  preview: {
    getPreviewConfig: () => ipcRenderer.invoke("loop:preview.config"),
    createTab: (tabId: string) => ipcRenderer.invoke("loop:preview.createTab", { tabId }),
    closeTab: (tabId: string) => ipcRenderer.invoke("loop:preview.closeTab", { tabId }),
    registerWebview: (tabId: string, webContentsId: number) =>
      ipcRenderer.invoke("loop:preview.registerWebview", { tabId, webContentsId }),
    navigate: (tabId: string, url: string) =>
      ipcRenderer.invoke("loop:preview.navigate", { tabId, url }),
    goBack: (tabId: string) => ipcRenderer.invoke("loop:preview.goBack", { tabId }),
    goForward: (tabId: string) => ipcRenderer.invoke("loop:preview.goForward", { tabId }),
    refresh: (tabId: string) => ipcRenderer.invoke("loop:preview.refresh", { tabId }),
    hardReload: (tabId: string) => ipcRenderer.invoke("loop:preview.hardReload", { tabId }),
    zoomIn: (tabId: string) => ipcRenderer.invoke("loop:preview.zoomIn", { tabId }),
    zoomOut: (tabId: string) => ipcRenderer.invoke("loop:preview.zoomOut", { tabId }),
    resetZoom: (tabId: string) => ipcRenderer.invoke("loop:preview.resetZoom", { tabId }),
    setColorScheme: (tabId: string, colorScheme: string) =>
      ipcRenderer.invoke("loop:preview.setColorScheme", { tabId, colorScheme }),
    openDevTools: (tabId: string) => ipcRenderer.invoke("loop:preview.openDevTools", { tabId }),
    clearCookies: () => ipcRenderer.invoke("loop:preview.clearCookies"),
    clearCache: () => ipcRenderer.invoke("loop:preview.clearCache"),
    captureScreenshot: (tabId: string) => ipcRenderer.invoke("loop:preview.screenshot", { tabId }),
    revealArtifact: (path: string) => ipcRenderer.invoke("loop:preview.revealArtifact", { path }),
    copyArtifactToClipboard: (path: string) =>
      ipcRenderer.invoke("loop:preview.copyArtifact", { path }),
    // The picker paints its own fixed highlight (apps/desktop/src/previewPicker.ts)
    // rather than a themed overlay, so there is nothing to push a theme into —
    // but the host syncs one on every theme change and must not see a rejection.
    setAnnotationTheme: () => Promise.resolve(),
    pickElement: (tabId: string) => ipcRenderer.invoke("loop:preview.pickElement", { tabId }),
    cancelPickElement: (tabId: string) =>
      ipcRenderer.invoke("loop:preview.cancelPickElement", { tabId }),
    pictureInPicture: {
      open: unsupported("Popping the preview out"),
      close: unsupported("Popping the preview out"),
    },
    recording: {
      startScreencast: (tabId: string) =>
        ipcRenderer.invoke("loop:preview.startScreencast", { tabId }),
      stopScreencast: (tabId: string) =>
        ipcRenderer.invoke("loop:preview.stopScreencast", { tabId }),
      save: (tabId: string, mimeType: string, data: Uint8Array) =>
        ipcRenderer.invoke("loop:preview.saveRecording", { tabId, mimeType, data }),
      onFrame(listener: (frame: unknown) => void): () => void {
        previewFrameListeners.add(listener);
        return () => previewFrameListeners.delete(listener);
      },
    },
    // Reached only when the agent drives the browser, which needs server-side
    // methods loop does not implement (`previewAutomation.*` all fail).
    automation: {
      status: unsupported("Browser automation"),
      snapshot: unsupported("Browser automation"),
      click: unsupported("Browser automation"),
      type: unsupported("Browser automation"),
      press: unsupported("Browser automation"),
      scroll: unsupported("Browser automation"),
      evaluate: unsupported("Browser automation"),
      waitFor: unsupported("Browser automation"),
    },
    onStateChange(listener: (tabId: string, state: unknown) => void): () => void {
      previewStateListeners.add(listener);
      return () => previewStateListeners.delete(listener);
    },
    /** No agent cursor without automation, so this never fires. */
    onPointerEvent(): () => void {
      return () => {};
    },
  },
  window: {
    /** macOS hides the traffic lights in fullscreen, so the header's inset
        for them has to come back off. */
    isFullscreen(): Promise<boolean> {
      return ipcRenderer.invoke("loop:window.isFullscreen");
    },
    onFullscreenChange(listener: (fullscreen: boolean) => void): () => void {
      fullscreenListeners.add(listener);
      return () => fullscreenListeners.delete(listener);
    },
    /** From BrowserWindow, not the document: focusing a <webview> blurs the
        document while the window is still in front. */
    isFocused(): Promise<boolean> {
      return ipcRenderer.invoke("loop:window.isFocused");
    },
    onFocusChange(listener: (focused: boolean) => void): () => void {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
  },
  anchorCwd(): Promise<string | undefined> {
    return ipcRenderer
      .invoke("loop:call", { method: "server.info", params: {} })
      .then(unwrap)
      .then((info) => (info as { defaults?: { cwd?: string } } | undefined)?.defaults?.cwd)
      .catch(() => undefined);
  },
});
