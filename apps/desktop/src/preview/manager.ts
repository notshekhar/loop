/**
 * The browser panel's main-process half.
 *
 * The renderer paints a `<webview>` per preview tab, but a guest webview is
 * driven from the main process, not from the page that hosts it: the embedder
 * gets a DOM element and a `getWebContentsId()`, and everything else — load a
 * URL, go back, zoom, tell me when the page finished loading — lives on the
 * `WebContents` behind that id.
 *
 * That half was missing. The renderer asks for it as `preview.getPreviewConfig()`
 * before it will mount a webview at all (apps/web/src/browser/HostedBrowserWebview.tsx
 * returns null while the config is unresolved), so with nothing answering, the
 * panel enabled its Browser tab, accepted a URL, recorded the tab server-side —
 * and never created a single webview. Typing chess.com did nothing, silently.
 */
import { session, webContents as electronWebContents, type WebContents } from "electron";
import { EventEmitter } from "node:events";

import type { PreviewAnnotationPayload } from "../previewPicker";
import { PreviewArtifacts } from "./artifacts";
import { applyColorScheme, startScreencast, stopScreencast } from "./devtoolsProtocol";
import { cancelPickElement, pickElement } from "./elementPick";
import { bindNavigationListeners } from "./navigationListeners";
import {
  alive,
  nowIso,
  PREVIEW_PARTITION,
  type PreviewArtifact,
  type PreviewColorScheme,
  type PreviewTabState,
  type PreviewWebviewConfig,
  type Tab,
} from "./types";

/**
 * The guest's own security posture, as a `<webview webpreferences>` string.
 *
 * loop ships no picker preload, so unlike upstream there is no reason to
 * weaken context isolation: the guest is an ordinary sandboxed web page with
 * no bridge into either the app or Node. Element picking is injected on demand
 * instead (apps/desktop/src/previewPicker.ts), which needs none of that.
 *
 * `plugins` is what enables Chromium's built-in PDF viewer, and nothing else —
 * the plugin architectures it used to gate are long gone. Without it a `.pdf`
 * the panel is asked to open (openFileInPreview treats pdf as previewable)
 * downloads instead of rendering.
 */
const WEBVIEW_PREFERENCES = "contextIsolation=yes,sandbox=yes,nodeIntegration=no,plugins=yes";

/** Chrome's zoom ladder, which is what the +/- buttons are expected to walk. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** Float slack, so a factor a hair off a step still counts as that step. */
const ZOOM_EPSILON = 0.001;

function newTab(tabId: string): Tab {
  return {
    tabId,
    contents: null,
    navStatus: { kind: "Idle" },
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    colorScheme: "system",
    screencasting: false,
    detach: null,
  };
}

export class PreviewManager extends EventEmitter {
  readonly #tabs = new Map<string, Tab>();
  readonly #artifacts = new PreviewArtifacts();

  /**
   * Everything the renderer needs to mount a webview, in one call.
   *
   * `preloadUrl: null` is a real answer, not a stub: it is how the renderer is
   * told there is no element picker in this build.
   */
  getPreviewConfig(): PreviewWebviewConfig {
    return {
      partition: PREVIEW_PARTITION,
      webPreferences: WEBVIEW_PREFERENCES,
      preloadUrl: null,
    };
  }

  createTab(tabId: string): void {
    if (this.#tabs.has(tabId)) return;
    this.#tabs.set(tabId, newTab(tabId));
    this.#emit(tabId);
  }

  closeTab(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    stopScreencast(tab);
    tab.detach?.();
    this.#tabs.delete(tabId);
  }

  /**
   * Bind a tab to the guest the renderer just attached.
   *
   * Called again on every `did-attach` and `dom-ready`, and after a crash the
   * renderer swaps the element for a fresh one — so this has to be idempotent
   * and has to replace an earlier binding rather than stack listeners on it.
   */
  registerWebview(tabId: string, webContentsId: number): void {
    const tab = this.#tabs.get(tabId) ?? this.#create(tabId);
    const contents = electronWebContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) return;
    if (tab.contents === contents) return;

    tab.detach?.();
    tab.contents = contents;
    const { detach, sync } = bindNavigationListeners(tab, contents, () => this.#emit(tabId));
    tab.detach = detach;

    // A swapped-in guest starts at the defaults; re-apply what the tab was set
    // to so a crash recovery does not silently reset the user's zoom.
    contents.setZoomFactor(tab.zoomFactor);
    if (tab.colorScheme !== "system") void applyColorScheme(tab);
    sync();
  }

  /**
   * Point a tab at a URL.
   *
   * `loadURL` rejects on the same aborts that `did-fail-load` filters out, so
   * the rejection is swallowed here and the page's real outcome comes back
   * through the navigation listeners. Rejecting would make the address bar
   * report a failure for a load that is about to succeed.
   */
  async navigate(tabId: string, url: string): Promise<void> {
    const contents = this.#require(tabId);
    try {
      await contents.loadURL(url);
    } catch {
      // Reported by did-fail-load when it is a real failure.
    }
  }

  goBack(tabId: string): void {
    const contents = this.#require(tabId);
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  }

  goForward(tabId: string): void {
    const contents = this.#require(tabId);
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  }

  refresh(tabId: string): void {
    this.#require(tabId).reload();
  }

  hardReload(tabId: string): void {
    this.#require(tabId).reloadIgnoringCache();
  }

  zoomIn(tabId: string): void {
    this.#setZoom(
      tabId,
      (current) => ZOOM_STEPS.find((step) => step > current + ZOOM_EPSILON) ?? current,
    );
  }

  zoomOut(tabId: string): void {
    this.#setZoom(
      tabId,
      (current) =>
        [...ZOOM_STEPS].reverse().find((step) => step < current - ZOOM_EPSILON) ?? current,
    );
  }

  resetZoom(tabId: string): void {
    this.#setZoom(tabId, () => 1);
  }

  async setColorScheme(tabId: string, colorScheme: PreviewColorScheme): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    tab.colorScheme = colorScheme;
    await applyColorScheme(tab);
    this.#emit(tabId);
  }

  /**
   * DevTools and CDP are mutually exclusive on one WebContents.
   *
   * A colour-scheme override holds the debugger open, and Electron answers
   * `openDevTools` with "another debugger is already attached" while it does —
   * so the override is dropped for as long as DevTools is the thing the user
   * asked for, and reinstated when they close it.
   */
  openDevTools(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    const contents = this.#require(tabId);
    if (tab && !tab.screencasting && contents.debugger.isAttached()) {
      contents.debugger.detach();
    }
    contents.openDevTools({ mode: "detach" });
    if (tab && tab.colorScheme !== "system") {
      contents.once("devtools-closed", () => {
        void applyColorScheme(tab);
      });
    }
  }

  async pickElement(tabId: string): Promise<PreviewAnnotationPayload | null> {
    const contents = this.#require(tabId);
    // Zoom is read once the pick lands, so a zoom mid-pick crops at the new factor.
    return pickElement(contents, () => this.#tabs.get(tabId)?.zoomFactor ?? 1);
  }

  cancelPickElement(tabId: string): void {
    const contents = this.#tabs.get(tabId)?.contents ?? null;
    if (alive(contents)) cancelPickElement(contents);
  }

  async clearCookies(): Promise<void> {
    await session.fromPartition(PREVIEW_PARTITION).clearStorageData();
  }

  async clearCache(): Promise<void> {
    await session.fromPartition(PREVIEW_PARTITION).clearCache();
  }

  async captureScreenshot(tabId: string): Promise<PreviewArtifact> {
    return this.#artifacts.captureScreenshot(tabId, this.#require(tabId));
  }

  revealArtifact(path: string): void {
    this.#artifacts.reveal(path);
  }

  async copyArtifactToClipboard(path: string): Promise<void> {
    await this.#artifacts.copyToClipboard(path);
  }

  /** Stream the guest's frames to the renderer, which assembles them into a video. */
  async startScreencast(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    const contents = this.#require(tabId);
    if (!tab || tab.screencasting) return;
    await startScreencast(tab, contents, (frame) => this.emit("frame", frame));
  }

  async stopScreencast(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    stopScreencast(tab);
  }

  async saveRecording(tabId: string, mimeType: string, data: Uint8Array): Promise<PreviewArtifact> {
    return this.#artifacts.saveRecording(tabId, mimeType, data);
  }

  /** Every tab's state, for a renderer that reloaded and lost its copy. */
  states(): PreviewTabState[] {
    return [...this.#tabs.keys()].map((tabId) => this.#state(tabId)).filter((s) => s !== null);
  }

  disposeAll(): void {
    for (const tabId of [...this.#tabs.keys()]) this.closeTab(tabId);
  }

  #create(tabId: string): Tab {
    this.createTab(tabId);
    return this.#tabs.get(tabId)!;
  }

  /**
   * The tab's live WebContents, or a message the renderer can show.
   *
   * Throwing beats a silent no-op: every caller either awaits this behind a
   * toast or ignores the result, and "the page isn't loaded yet" is far easier
   * to act on than a button that does nothing.
   */
  #require(tabId: string): WebContents {
    const contents = this.#tabs.get(tabId)?.contents ?? null;
    if (!alive(contents)) {
      throw new Error(`Preview tab ${tabId} has no live page.`);
    }
    return contents;
  }

  #setZoom(tabId: string, next: (current: number) => number): void {
    const tab = this.#tabs.get(tabId);
    const contents = this.#require(tabId);
    if (!tab) return;
    tab.zoomFactor = next(tab.zoomFactor);
    contents.setZoomFactor(tab.zoomFactor);
    this.#emit(tabId);
  }

  #state(tabId: string): PreviewTabState | null {
    const tab = this.#tabs.get(tabId);
    if (!tab) return null;
    return {
      tabId,
      webContentsId: alive(tab.contents) ? tab.contents.id : null,
      navStatus: tab.navStatus,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      zoomFactor: tab.zoomFactor,
      // Neither is wired in loop's shell: there is no pop-out window, and no
      // agent drives the browser, so the tab is always the human's.
      pictureInPicture: false,
      colorScheme: tab.colorScheme,
      controller: "none",
      updatedAt: nowIso(),
    };
  }

  #emit(tabId: string): void {
    const state = this.#state(tabId);
    if (state) this.emit("state", state);
  }
}
