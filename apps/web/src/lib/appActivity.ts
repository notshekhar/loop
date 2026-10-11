/**
 * Whether anyone is looking at the app — the one signal battery-minded work
 * keys on.
 *
 * Two inputs. **Visible**: the document is not hidden (minimized, another
 * tab). **Focused**: the window is the one in front. On the desktop, focus
 * comes from the main process (BrowserWindow focus/blur), not from the
 * document: clicking into the browser panel's `<webview>` blurs the document
 * while the window is still very much in front, and pausing the UI then would
 * freeze it while the user looks straight at it. In a browser, the document's
 * own focus is the only source and is right there.
 *
 * Consumers:
 * - `data-window-inactive` on <html>: ambient CSS animations (the working
 *   indicator, sidebar pulses) pause under it — index.css.
 * - polls that only keep the screen current (git status fallback) slow down
 *   while inactive and catch up the moment the app is active again.
 */
import { loopWindow } from "../loop/transport";

type Listener = (active: boolean) => void;

// Defensive reads: tests and prerender stub a partial document.
const hasDocument = typeof document !== "undefined";
let visible =
  hasDocument && document.visibilityState !== undefined
    ? document.visibilityState === "visible"
    : true;
let focused = hasDocument && typeof document.hasFocus === "function" ? document.hasFocus() : true;
let installed = false;
const listeners = new Set<Listener>();

export function isAppVisible(): boolean {
  return visible;
}

export function isAppActive(): boolean {
  return visible && focused;
}

/** Called with the new value whenever `isAppActive()` changes. */
export function subscribeAppActivity(listener: Listener): () => void {
  installAppActivity();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(next: { visible?: boolean; focused?: boolean }): void {
  const before = isAppActive();
  if (next.visible !== undefined) visible = next.visible;
  if (next.focused !== undefined) focused = next.focused;
  const after = isAppActive();
  document.documentElement?.toggleAttribute?.("data-window-inactive", !after);
  if (after !== before) for (const listener of listeners) listener(after);
}

/** Start tracking. Idempotent; called at boot and by the first subscriber. */
export function installAppActivity(): void {
  if (
    installed ||
    typeof document === "undefined" ||
    typeof document.addEventListener !== "function"
  ) {
    return;
  }
  installed = true;
  document.addEventListener("visibilitychange", () =>
    update({ visible: document.visibilityState === "visible" }),
  );
  const host = loopWindow();
  if (host?.onFocusChange) {
    host.onFocusChange((next) => update({ focused: next }));
    void host
      .isFocused?.()
      .then((next) => update({ focused: next }))
      .catch(() => undefined);
  } else {
    window.addEventListener("focus", () => update({ focused: true }));
    window.addEventListener("blur", () => update({ focused: false }));
  }
  update({});
}
