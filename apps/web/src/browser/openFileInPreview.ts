import type {
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@loop/contracts";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@loop/runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  readThreadPreviewState,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewRuntimeTabId } from "./previewRuntimeTabId";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

/**
 * Point the thread's browser panel at a URL.
 *
 * Reuses the tab the panel is already showing, the way clicking a link in a
 * browser does. Opening unconditionally minted a tab per click — the registry's
 * `open` has no dedupe — so following three links from a reply left three tabs
 * behind, and the tab strip filled up with the same page's history. A new tab
 * is what the panel's own "+" button is for.
 *
 * The guest is driven imperatively (`previewBridge.navigate`) exactly as the
 * address bar drives it; `usePreviewBridge` mirrors the resolved URL back into
 * the tab registry, so the strip and the address bar stay in step.
 */
export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  const existing = readThreadPreviewState(input.threadRef);
  const reusableTabId = existing.activeTabId;
  if (previewBridge && reusableTabId && existing.sessions[reusableTabId]) {
    await previewBridge.navigate(
      previewRuntimeTabId(input.threadRef, existing.serverEpoch, reusableTabId),
      input.url,
    );
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, reusableTabId);
    return AsyncResult.success(undefined);
  }

  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

/**
 * A local path as a URL the browser panel can actually load.
 *
 * Windows drive paths and UNC shares both have to survive, and every segment
 * needs encoding — a space or a `#` in a filename otherwise truncates the URL
 * or turns the rest of the name into a fragment.
 */
export function fileUrlFromAbsolutePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const isWindowsDrive = /^[A-Za-z]:\//.test(normalized);
  const isUnc = normalized.startsWith("//");
  if (!normalized.startsWith("/") && !isWindowsDrive) return null;

  const [host, segments] = isUnc
    ? [normalized.slice(2).split("/")[0] ?? "", normalized.slice(2).split("/").slice(1)]
    : ["", normalized.split("/")];
  const encoded = segments
    // The drive letter's colon is structure, not content: encoding it to `%3A`
    // leaves Chromium with a path segment rather than a drive.
    .map((segment, index) =>
      isWindowsDrive && index === 0 ? segment : encodeURIComponent(segment),
    )
    .join("/");
  return isWindowsDrive ? `file:///${encoded}` : `file://${host}${isUnc ? "/" : ""}${encoded}`;
}

/**
 * Open a workspace file in the browser panel.
 *
 * The panel's guest is a `<webview>` on its own session, so it has to be given
 * a URL it can resolve for itself. It used to be handed the blob URL that
 * `assets.createUrl` mints, which cannot work: a blob URL is scoped to the
 * document that created it — the renderer — so the guest reported the page as
 * not found, and even if it had loaded, every relative stylesheet, script and
 * image in the page would have resolved against `blob:` and failed too.
 *
 * A `file://` URL is what the guest can load: relative assets resolve next to
 * the file, reload works, and the address bar shows where the page came from.
 * The panel only exists in the desktop shell, where the file is on this
 * machine, so there is no case left for shipping the bytes through the bridge.
 */
export async function openFileInPreview<PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<AtomCommandResult<void, PreviewError | BrowserPreviewUnavailableError>> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const fileUrl = fileUrlFromAbsolutePath(input.filePath);
  if (fileUrl === null) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: `"${input.filePath}" is not an absolute path.`,
        }),
      ),
    );
  }
  return openUrlInPreview({
    threadRef: input.threadRef,
    url: fileUrl,
    openPreview: input.openPreview,
  });
}
