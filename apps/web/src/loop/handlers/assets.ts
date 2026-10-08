/**
 * Workspace assets, as blob URLs.
 *
 * Upstream mints a short-lived URL against its own HTTP server and lets the
 * browser fetch the bytes back over it. loop has no such server — the renderer
 * is served from the shell's `app:` scheme and the agent speaks JSON-RPC — so
 * the bytes come across the preload bridge instead and are wrapped in a blob
 * URL here. The contract only asks for something `new URL(…, httpBaseUrl)`
 * resolves; a blob URL is absolute, so the base is ignored and the `<img>`
 * loads it directly. It also fits the contract's 4096-character cap, which a
 * data: URL of a real screenshot would not.
 *
 * Until this existed `assets.createUrl` failed outright, and every image in
 * the Files panel rendered as "Unable to load workspace image".
 */
import { AssetWorkspaceContextNotFoundError, type AssetResource } from "@loop/contracts";
import * as Effect from "effect/Effect";

import { defaultLoopHost, type LoopHost } from "../transport.ts";

/**
 * How long the caller may treat the URL as good for. A blob URL lives until
 * the document does, so this only drives the query atom's refresh — long
 * enough that scrolling a folder of images does not re-read them.
 */
const ASSET_TTL_MS = 60 * 60_000;

/**
 * One blob per path, revoked when the path is re-read.
 *
 * The asset atom refreshes on a timer; minting a new blob every time would
 * leak the old one for the life of the window, and a folder of screenshots
 * would grow the renderer's memory without bound.
 */
/** Keyed by host and path: the same path on two machines is two files. */
const blobUrlsByPath = new Map<string, string>();

function assetPath(resource: AssetResource): string | null {
  // `attachment` has no path (loop has no attachment store) and
  // `project-favicon` would need a network fetch of the project's site.
  return resource._tag === "workspace-file" ? resource.path : null;
}

export const createAssetUrl = Effect.fnUntraced(function* (
  input: {
    readonly resource: AssetResource;
  },
  host: LoopHost = defaultLoopHost,
) {
  const path = assetPath(input.resource);
  const filesystem = host.filesystem();
  if (path === null || !filesystem?.readAsset) {
    return yield* Effect.fail(
      new AssetWorkspaceContextNotFoundError({ resource: input.resource }),
    );
  }

  const result = yield* Effect.promise(() => filesystem.readAsset!(path));
  if (!result.ok) {
    return yield* Effect.fail(
      new AssetWorkspaceContextNotFoundError({ resource: input.resource }),
    );
  }

  const key = `${host.id}\0${path}`;
  const previous = blobUrlsByPath.get(key);
  if (previous) URL.revokeObjectURL(previous);
  // Copied into an own-buffer view: what crosses IPC is typed as a view over
  // `ArrayBufferLike`, which `Blob` will not take.
  const bytes = new Uint8Array(result.data.byteLength);
  bytes.set(result.data);
  const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
  blobUrlsByPath.set(key, url);

  return { relativeUrl: url, expiresAt: Date.now() + ASSET_TTL_MS };
});

