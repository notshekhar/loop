import {
  loadMoreSessions,
  sessionPagingVersion,
  sessionWindow,
  subscribeSessionPaging,
  watchSessionFolder,
} from "@loop/handlers/sessionPaging";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

export interface SessionPagingScope {
  /** Hosts whose whole list is on screen. */
  readonly environmentIds: readonly string[];
  /** When a project is picked: just these folders, each with its own window. */
  readonly folders: ReadonlyArray<{ readonly environmentId: string; readonly cwd: string }> | null;
}

/**
 * Infinite scroll over loop's sessions (apps/web/src/loop/handlers/sessionPaging.ts):
 * the shell holds the newest page of each host, and `loadMore` — called as the
 * list nears its end — widens it by a page.
 */
export function useSessionPaging(scope: SessionPagingScope) {
  useSyncExternalStore(subscribeSessionPaging, sessionPagingVersion);
  const foldersKey = scope.folders?.map((f) => `${f.environmentId}\u0000${f.cwd}`).join("\u0001") ?? "";
  const folders = useMemo(() => scope.folders, [foldersKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A project view lists that folder's own newest page, not whatever of it
  // happened to be in the newest page of the whole host.
  useEffect(() => {
    for (const folder of folders ?? []) watchSessionFolder(folder.environmentId, folder.cwd);
  }, [folders]);

  const windows = folders
    ? folders.map((f) => sessionWindow(f.environmentId, f.cwd))
    : scope.environmentIds.map((id) => sessionWindow(id));
  const loading = windows.some((w) => w.loading);
  const hasMore = windows.some((w) => w.hasMore);

  const environmentIdsKey = scope.environmentIds.join("\u0000");
  const loadMore = useCallback(() => {
    if (folders) for (const f of folders) loadMoreSessions(f.environmentId, f.cwd);
    else for (const id of environmentIdsKey.split("\u0000")) if (id) loadMoreSessions(id);
  }, [folders, environmentIdsKey]);

  return { loading, hasMore, loadMore };
}
