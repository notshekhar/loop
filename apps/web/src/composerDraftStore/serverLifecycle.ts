import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@loop/contracts";
import { parseScopedProjectKey, parseScopedThreadKey } from "@loop/runtime/environment";
import { revokeDraftThreadPreviewUrls } from "./draftContent";
import { DraftId } from "./schema";
import { composerDebouncedStorage } from "./storage";
import { useComposerDraftStore } from "./store";
import type { ComposerThreadDraftState, ComposerThreadTarget, DraftThreadState } from "./types";

export function clearComposerDraftsEnvironment(environmentId: EnvironmentId): void {
  useComposerDraftStore.setState((state) => {
    const removedThreadKeys = new Set<string>();

    for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      if (draftThread.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const threadKey of Object.keys(state.draftsByThreadKey)) {
      if (parseScopedThreadKey(threadKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const [logicalProjectKey, threadKey] of Object.entries(
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    )) {
      if (parseScopedProjectKey(logicalProjectKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([logicalProjectKey, threadKey]) =>
          parseScopedProjectKey(logicalProjectKey)?.environmentId !== environmentId &&
          !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, string>;
    const nextDraftThreads = Object.fromEntries(
      Object.entries(state.draftThreadsByThreadKey).filter(
        ([threadKey, draftThread]) =>
          draftThread.environmentId !== environmentId && !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, DraftThreadState>;
    const nextDrafts = Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([threadKey, draft]) => {
        if (!removedThreadKeys.has(threadKey)) {
          return true;
        }
        revokeDraftThreadPreviewUrls(draft);
        return false;
      }),
    ) as Record<string, ComposerThreadDraftState>;

    return {
      draftsByThreadKey: nextDrafts,
      draftThreadsByThreadKey: nextDraftThreads,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
    };
  });
  composerDebouncedStorage.flush();
}

/**
 * Mark a draft thread as promoting once the server has materialized the same thread id.
 *
 * Use the single-thread helper for live `thread.created` events and the
 * iterable helper for bootstrap/recovery paths that discover multiple server
 * threads at once.
 */
export function markPromotedDraftThread(threadId: ThreadId): void {
  const store = useComposerDraftStore.getState();
  const draftThreadTargets: ComposerThreadTarget[] = [];
  for (const [draftId, draftThread] of Object.entries(store.draftThreadsByThreadKey)) {
    if (draftThread.threadId === threadId) {
      draftThreadTargets.push(DraftId.make(draftId));
    }
  }
  if (draftThreadTargets.length === 0) {
    return;
  }
  for (const draftThreadTarget of draftThreadTargets) {
    store.markDraftThreadPromoting(draftThreadTarget);
  }
}

export function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    if (
      draftThread.environmentId === threadRef.environmentId &&
      draftThread.threadId === threadRef.threadId
    ) {
      draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef);
    }
  }
}

export function markPromotedDraftThreads(serverThreadIds: Iterable<ThreadId>): void {
  for (const threadId of serverThreadIds) {
    markPromotedDraftThread(threadId);
  }
}

export function markPromotedDraftThreadsByRef(serverThreadRefs: Iterable<ScopedThreadRef>): void {
  for (const threadRef of serverThreadRefs) {
    markPromotedDraftThreadByRef(threadRef);
  }
}

export function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    const promotedRef = draftThread.promotedTo;
    const matches = promotedRef
      ? promotedRef.environmentId === threadRef.environmentId &&
        promotedRef.threadId === threadRef.threadId
      : draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId;
    if (matches) {
      const target = DraftId.make(draftId);
      draftStore.markDraftThreadPromoting(target, threadRef);
      draftStore.finalizePromotedDraftThread(target);
    }
  }
}

