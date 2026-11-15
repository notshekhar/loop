/** The app's one window: opening it, keeping it in the app, and sending it events. */
import { BrowserWindow, screen, shell } from "electron";

import { RENDERER_ORIGIN } from "./rendererProtocol.js";

export interface MainWindowOptions {
  preloadPath: string;
  /** Linux and Windows only — macOS takes its icon from the app bundle. */
  iconPath: string;
  /** Fires on the first load and on every reload. */
  onLoad: () => void;
}

export class MainWindow {
  private window: BrowserWindow | null = null;

  constructor(private readonly options: MainWindowOptions) {}

  /** The window, while it is open. */
  get current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  open(): void {
    const window = new BrowserWindow(this.windowOptions());
    this.window = window;
    keepNavigationInApp(window);
    this.forwardWindowState(window);
    window.on("closed", () => {
      this.window = null;
    });
    // Fires on the first load and on every reload, which is exactly when the
    // renderer's end of the terminal pipe needs replacing — the previous one
    // died with the document that held it.
    window.webContents.on("did-finish-load", this.options.onLoad);
    void window.loadURL(`${RENDERER_ORIGIN}/`);
  }

  /**
   * Someone tried to launch a second copy — show them the one already running.
   *
   * Refusing to start without this would look like the app failing to open: the
   * click does nothing, no window appears, and the natural response is to click
   * again. Raising the existing window is what makes the single instance feel
   * intentional rather than broken. A minimized window has to be restored
   * first; `focus()` alone leaves it in the Dock.
   */
  reveal(): void {
    const window = this.current;
    if (!window) {
      this.open();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  forward(channel: string, payload: unknown): void {
    this.current?.webContents.send(channel, payload);
  }

  isFullScreen(): boolean {
    return this.window?.isFullScreen() ?? false;
  }

  isFocused(): boolean {
    return this.window?.isFocused() ?? false;
  }

  private windowOptions(): Electron.BrowserWindowConstructorOptions {
    // Open filling the screen. Sized to the work area at construction rather than
    // `maximize()`d after it, because the latter paints a 1440x900 window first
    // and then snaps — and the work area already excludes the menu bar, the Dock
    // and the taskbar, so this is "as big as a window is allowed to be" without
    // going fullscreen (which on macOS would take over a whole space).
    const { workArea } = screen.getPrimaryDisplay();
    return {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      minWidth: 720,
      minHeight: 480,
      // Matches the renderer's dark workspace, so the frame Electron paints
      // before the first render isn't a different gray than the app that lands in it.
      backgroundColor: "#191919",
      // macOS takes its icon from the app bundle, so this is for Linux and
      // Windows, where an unset icon means the default Electron diamond.
      ...(process.platform === "darwin" ? {} : { icon: this.options.iconPath }),
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      trafficLightPosition: { x: 16, y: 18 },
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The browser panel renders each preview tab as a <webview>, which
        // Electron disables by default — without this the panel mounts and
        // stays blank, with no error to go on.
        webviewTag: true,
      },
    };
  }

  private forwardWindowState(window: BrowserWindow): void {
    // The renderer insets its header to clear the traffic lights, and macOS
    // hides them in fullscreen — so without this the inset becomes a gap.
    window.on("enter-full-screen", () => this.forward("loop:fullscreen", true));
    window.on("leave-full-screen", () => this.forward("loop:fullscreen", false));

    // Ambient animations pause and display-only polls slow down while the window
    // is not in front (apps/web lib/appActivity.ts). Sent from here because the
    // document's own blur also fires when focus moves into a preview <webview>.
    window.on("focus", () => this.forward("loop:window.focus", true));
    window.on("blur", () => this.forward("loop:window.focus", false));
  }
}

/**
 * Links to the outside world open in the user's browser, never in the shell:
 * a navigated-away window has no way back and no address bar.
 */
function keepNavigationInApp(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(RENDERER_ORIGIN)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

/**
 * A preview guest is a browser, so its own links must not leak out of it.
 *
 * The window's two navigation handlers send every off-origin navigation to
 * the user's real browser — right for a link in the transcript, and exactly
 * wrong for the browser panel, where following a link is the whole point.
 * Guests get their own handler instead, and a `target=_blank` loads in the
 * panel rather than as a chromeless Electron window with no way back.
 *
 * `file:` is in the list because the panel opens local pages that way (see
 * openFileInPreview) — a generated report linking to a sibling page with
 * `target="_blank"` would otherwise do nothing at all.
 */
export function keepPreviewLinksInPanel(contents: Electron.WebContents): void {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(?:https?|file):\/\//i.test(url)) void contents.loadURL(url);
    return { action: "deny" };
  });
}
