/**
 * What a preview tab does over the Chrome DevTools Protocol: a colour-scheme
 * override and the screencast. Both share one debugger, so each one only lets
 * go of it when the other is not holding it.
 */
import type { WebContents } from "electron";

import { alive, nowIso, type PreviewScreencastFrame, type Tab } from "./types";

function attachDebugger(contents: WebContents): void {
  if (contents.debugger.isAttached()) return;
  contents.debugger.attach("1.3");
}

export async function applyColorScheme(tab: Tab): Promise<void> {
  const contents = tab.contents;
  if (!alive(contents)) return;
  try {
    attachDebugger(contents);
    await contents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features:
        tab.colorScheme === "system" ? [] : [{ name: "prefers-color-scheme", value: tab.colorScheme }],
    });
    if (tab.colorScheme === "system" && !tab.screencasting) contents.debugger.detach();
  } catch {
    // DevTools owns the debugger, or the guest went away mid-call. The
    // override is cosmetic; the page still renders.
  }
}

/**
 * Stream the guest's frames to `onFrame`. CDP is the only way to get them —
 * `capturePage` in a loop drops to single-digit fps and stalls the page it is
 * capturing.
 */
export async function startScreencast(
  tab: Tab,
  contents: WebContents,
  onFrame: (frame: PreviewScreencastFrame) => void,
): Promise<void> {
  attachDebugger(contents);
  tab.screencasting = true;
  contents.debugger.on("message", screencastFrameListener(tab, onFrame));
  await contents.debugger.sendCommand("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    everyNthFrame: 1,
  });
}

function screencastFrameListener(tab: Tab, onFrame: (frame: PreviewScreencastFrame) => void) {
  return (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (method !== "Page.screencastFrame" || !tab.screencasting) return;
    const metadata = (params["metadata"] ?? {}) as { deviceWidth?: number; deviceHeight?: number };
    onFrame({
      tabId: tab.tabId,
      data: String(params["data"] ?? ""),
      width: metadata.deviceWidth ?? 0,
      height: metadata.deviceHeight ?? 0,
      receivedAt: nowIso(),
    });
    // Chrome sends no further frames until the last one is acknowledged.
    const contents = tab.contents;
    if (alive(contents) && contents.debugger.isAttached()) {
      void contents.debugger
        .sendCommand("Page.screencastFrameAck", { sessionId: params["sessionId"] })
        .catch(() => undefined);
    }
  };
}

export function stopScreencast(tab: Tab): void {
  if (!tab.screencasting) return;
  tab.screencasting = false;
  const contents = tab.contents;
  if (!alive(contents) || !contents.debugger.isAttached()) return;
  void contents.debugger.sendCommand("Page.stopScreencast").catch(() => undefined);
  contents.debugger.removeAllListeners("message");
  if (tab.colorScheme === "system") {
    try {
      contents.debugger.detach();
    } catch {
      // Already gone.
    }
  }
}
