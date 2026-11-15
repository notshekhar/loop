/**
 * The shapes that cross the IPC boundary, plus the manager's own tab record.
 *
 * The renderer's contract is upstream's `DesktopPreviewBridge`. It is restated
 * here in plain types rather than imported, because this package does not
 * depend on `@loop/contracts` and never has; the shapes below must stay in
 * step with `apps/web/src/loop/contracts/ipc.ts`.
 */
import type { WebContents } from "electron";

/**
 * One session for every preview tab, separate from the app's own.
 *
 * `persist:` so a login survives a restart — a preview pointed at a staging
 * site should not ask for a password every launch — and separate so clearing
 * preview cookies cannot sign the user out of anything the app itself holds.
 */
export const PREVIEW_PARTITION = "persist:loop-preview";

export type PreviewColorScheme = "system" | "light" | "dark";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | { kind: "LoadFailed"; url: string; title: string; code: number; description: string };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: PreviewColorScheme;
  controller: "human" | "agent" | "none";
  updatedAt: string;
}

export interface PreviewWebviewConfig {
  partition: string;
  webPreferences: string;
  preloadUrl: string | null;
}

export interface PreviewArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface PreviewScreencastFrame {
  tabId: string;
  data: string;
  width: number;
  height: number;
  receivedAt: string;
}

export interface Tab {
  readonly tabId: string;
  contents: WebContents | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  colorScheme: PreviewColorScheme;
  screencasting: boolean;
  /** Removes every listener this manager put on `contents`. */
  detach: (() => void) | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function alive(contents: WebContents | null): contents is WebContents {
  return contents !== null && !contents.isDestroyed();
}
