/**
 * The browser panel.
 *
 * The renderer owns the `<webview>` element and this owns the guest behind
 * it — see preview.ts. Everything here is keyed by the renderer's tab id,
 * which is the only name the two halves share.
 */
import { ipcMain } from "electron";

import type { PreviewColorScheme, PreviewManager } from "../preview.js";
import type { Forward } from "./loopBridge.js";

type TabPayload = { tabId: string };

/** Tab actions whose result the renderer does not get back. */
const TAB_COMMANDS = [
  "createTab",
  "closeTab",
  "goBack",
  "goForward",
  "refresh",
  "hardReload",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "openDevTools",
  "cancelPickElement",
] as const satisfies readonly (keyof PreviewManager)[];

/** Tab calls answered with what the manager returns: `loop:preview.<channel>` → method. */
const TAB_QUERIES = {
  pickElement: "pickElement",
  screenshot: "captureScreenshot",
  startScreencast: "startScreencast",
  stopScreencast: "stopScreencast",
} as const satisfies Record<string, keyof PreviewManager>;

export function connectPreviews(previews: PreviewManager, forward: Forward): void {
  previews.on("state", (state) => forward("loop:preview.state", state));
  previews.on("frame", (frame) => forward("loop:preview.frame", frame));
  ipcMain.handle("loop:preview.config", () => previews.getPreviewConfig());
  ipcMain.handle("loop:preview.states", () => previews.states());
  handleTabCalls(previews);
  handleNavigationCalls(previews);
  handleBrowserDataCalls(previews);
  handleArtifactCalls(previews);
}

function handleTabCalls(previews: PreviewManager): void {
  for (const method of TAB_COMMANDS) {
    ipcMain.handle(`loop:preview.${method}`, (_event, p: TabPayload) => {
      previews[method](p.tabId);
    });
  }
  for (const [channel, method] of Object.entries(TAB_QUERIES)) {
    ipcMain.handle(`loop:preview.${channel}`, (_event, p: TabPayload) =>
      previews[method as (typeof TAB_QUERIES)[keyof typeof TAB_QUERIES]](p.tabId),
    );
  }
}

function handleNavigationCalls(previews: PreviewManager): void {
  ipcMain.handle(
    "loop:preview.registerWebview",
    (_event, p: { tabId: string; webContentsId: number }) => {
      previews.registerWebview(p.tabId, p.webContentsId);
    },
  );
  ipcMain.handle("loop:preview.navigate", (_event, p: { tabId: string; url: string }) =>
    previews.navigate(p.tabId, p.url),
  );
  ipcMain.handle(
    "loop:preview.setColorScheme",
    (_event, p: { tabId: string; colorScheme: PreviewColorScheme }) =>
      previews.setColorScheme(p.tabId, p.colorScheme),
  );
}

function handleBrowserDataCalls(previews: PreviewManager): void {
  ipcMain.handle("loop:preview.clearCookies", () => previews.clearCookies());
  ipcMain.handle("loop:preview.clearCache", () => previews.clearCache());
}

function handleArtifactCalls(previews: PreviewManager): void {
  ipcMain.handle("loop:preview.revealArtifact", (_event, p: { path: string }) => {
    previews.revealArtifact(p.path);
  });
  ipcMain.handle("loop:preview.copyArtifact", (_event, p: { path: string }) =>
    previews.copyArtifactToClipboard(p.path),
  );
  ipcMain.handle(
    "loop:preview.saveRecording",
    (_event, p: { tabId: string; mimeType: string; data: Uint8Array }) =>
      previews.saveRecording(p.tabId, p.mimeType, p.data),
  );
}
