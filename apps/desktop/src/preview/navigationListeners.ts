/** Keeping a tab's navigation state in step with the guest's own load events. */
import type { WebContents } from "electron";

import { alive, type Tab } from "./types";

/**
 * A load the user cancelled, or that a redirect superseded, is not a failure.
 *
 * `ERR_ABORTED` arrives on every ordinary in-page navigation away from a page
 * that is still loading; surfacing it would flash the "can't reach this page"
 * screen over a page that is about to render fine.
 */
const ERR_ABORTED = -3;

/** about:blank is the mount placeholder, not a page the user asked for. */
const isPlaceholder = (url: string) => url === "" || url === "about:blank";

/**
 * Listen to `contents` on `tab`'s behalf; `emit` reports the tab's new state.
 * `detach` removes every listener added here; `sync` re-reads the history now.
 */
export function bindNavigationListeners(
  tab: Tab,
  contents: WebContents,
  emit: () => void,
): { detach: () => void; sync: () => void } {
  const sync = () => {
    if (!alive(contents)) return;
    tab.canGoBack = contents.navigationHistory.canGoBack();
    tab.canGoForward = contents.navigationHistory.canGoForward();
    emit();
  };
  const loading = () => {
    if (!alive(contents)) return;
    const url = contents.getURL();
    if (isPlaceholder(url)) return;
    tab.navStatus = { kind: "Loading", url, title: contents.getTitle() || url };
    sync();
  };
  const settled = () => {
    if (!alive(contents)) return;
    const url = contents.getURL();
    if (isPlaceholder(url)) {
      tab.navStatus = { kind: "Idle" };
      sync();
      return;
    }
    // A failed load already wrote its own terminal status, and
    // `did-stop-loading` fires after it too — overwriting it here would
    // replace "can't reach this site" with a success for a blank page. The
    // next attempt clears it: `did-start-loading` always runs first.
    if (tab.navStatus.kind !== "LoadFailed") {
      tab.navStatus = { kind: "Success", url, title: contents.getTitle() || url };
    }
    sync();
  };
  const retitled = (_event: unknown, title: string) => {
    if (tab.navStatus.kind === "Idle") return;
    tab.navStatus = { ...tab.navStatus, title };
    emit();
  };
  const failed = (
    _event: unknown,
    code: number,
    description: string,
    validatedUrl: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || code === ERR_ABORTED) return;
    tab.navStatus = { kind: "LoadFailed", url: validatedUrl, title: validatedUrl, code, description };
    sync();
  };
  const gone = () => {
    if (tab.contents !== contents) return;
    tab.contents = null;
    tab.screencasting = false;
    emit();
  };

  const listeners = [
    ["did-start-loading", loading],
    ["did-stop-loading", settled],
    ["did-navigate", sync],
    ["did-navigate-in-page", settled],
    ["page-title-updated", retitled],
    ["did-fail-load", failed],
    ["destroyed", gone],
  ] as const;
  for (const [event, listener] of listeners) contents.on(event as never, listener as never);
  const detach = () => {
    for (const [event, listener] of listeners) contents.off(event as never, listener as never);
  };
  return { detach, sync };
}
