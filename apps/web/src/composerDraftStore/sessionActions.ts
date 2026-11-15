import { type ScopedProjectRef, ThreadId } from "@loop/contracts";
import { scopeThreadRef } from "@loop/runtime/environment";
import {
  createDraftThreadState,
  draftThreadsEqual,
  isComposerThreadKeyInUse,
  isDraftThreadPromoting,
  nextDraftThreadContext,
  removeDraftThreadReferences,
  scopedThreadRefsEqual,
} from "./draftSessions";
import type { DraftId } from "./schema";
import { logicalProjectDraftKey, projectDraftKey, resolveComposerDraftKey } from "./targets";
import type {
  ComposerDraftActionBuilder,
  ComposerDraftStoreState,
  DraftThreadOptions,
  DraftThreadState,
} from "./types";

type DraftSessionMaps = Pick<
  ComposerDraftStoreState,
  | "draftsByThreadKey"
  | "draftThreadsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
>;

function nextLogicalProjectDraftState(
  state: ComposerDraftStoreState,
  normalizedLogicalProjectKey: string,
  projectRef: ScopedProjectRef,
  draftId: DraftId,
  options: DraftThreadOptions | undefined,
): ComposerDraftStoreState | DraftSessionMaps {
  const existingThread = state.draftThreadsByThreadKey[draftId];
  const previousThreadKeyForLogicalProject =
    state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
  const nextDraftThread = createDraftThreadState(
    projectRef,
    options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
    normalizedLogicalProjectKey,
    existingThread,
    options,
  );
  const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId;
  if (hasSameLogicalMapping && draftThreadsEqual(existingThread, nextDraftThread)) {
    return state;
  }
  const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {
    ...state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    [normalizedLogicalProjectKey]: draftId,
  };
  const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
    ...state.draftThreadsByThreadKey,
    [draftId]: nextDraftThread,
  };
  let nextDraftsByThreadKey = state.draftsByThreadKey;
  const previousDraftThread =
    previousThreadKeyForLogicalProject === undefined
      ? undefined
      : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
  if (
    previousThreadKeyForLogicalProject &&
    previousThreadKeyForLogicalProject !== draftId &&
    !isComposerThreadKeyInUse(
      nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
      previousThreadKeyForLogicalProject,
    ) &&
    !isDraftThreadPromoting(previousDraftThread)
  ) {
    delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
    if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined) {
      nextDraftsByThreadKey = { ...state.draftsByThreadKey };
      delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject];
    }
  }
  return {
    draftsByThreadKey: nextDraftsByThreadKey,
    draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
  };
}

const setLogicalProjectDraftThreadId: ComposerDraftActionBuilder<
  "setLogicalProjectDraftThreadId"
> = (set) => (logicalProjectKey, projectRef, draftId, options) => {
  const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
  if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0) {
    return;
  }
  set((state) =>
    nextLogicalProjectDraftState(state, normalizedLogicalProjectKey, projectRef, draftId, options),
  );
};

const setProjectDraftThreadId: ComposerDraftActionBuilder<"setProjectDraftThreadId"> =
  (_set, get) => (projectRef, draftId, options) => {
    get().setLogicalProjectDraftThreadId(
      projectDraftKey(projectRef),
      projectRef,
      draftId,
      options,
    );
  };

const setDraftThreadContext: ComposerDraftActionBuilder<"setDraftThreadContext"> =
  (set, get) => (threadRef, options) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const existing = state.draftThreadsByThreadKey[threadKey];
      if (!existing) {
        return state;
      }
      const nextProjectRef = options.projectRef ?? {
        environmentId: existing.environmentId,
        projectId: existing.projectId,
      };
      if (nextProjectRef.projectId.length === 0 || nextProjectRef.environmentId.length === 0) {
        return state;
      }
      const nextDraftThread = nextDraftThreadContext(existing, nextProjectRef, options);
      if (draftThreadsEqual(existing, nextDraftThread)) {
        return state;
      }
      return {
        draftThreadsByThreadKey: {
          ...state.draftThreadsByThreadKey,
          [threadKey]: nextDraftThread,
        },
      };
    });
  };

const clearProjectDraftThreadId: ComposerDraftActionBuilder<"clearProjectDraftThreadId"> =
  (set) => (projectRef) => {
    set((state) => {
      const matchingThreadEntry = Object.entries(state.draftThreadsByThreadKey).find(
        ([, draftThread]) =>
          draftThread.projectId === projectRef.projectId &&
          draftThread.environmentId === projectRef.environmentId,
      );
      if (!matchingThreadEntry) {
        return state;
      }
      return removeDraftThreadReferences(state, matchingThreadEntry[0]);
    });
  };

const clearProjectDraftThreadById: ComposerDraftActionBuilder<"clearProjectDraftThreadById"> =
  (set, get) => (projectRef, threadRef) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const draftThread = state.draftThreadsByThreadKey[threadKey];
      if (
        !draftThread ||
        draftThread.projectId !== projectRef.projectId ||
        draftThread.environmentId !== projectRef.environmentId
      ) {
        return state;
      }
      return removeDraftThreadReferences(state, threadKey);
    });
  };

const markDraftThreadPromoting: ComposerDraftActionBuilder<"markDraftThreadPromoting"> =
  (set, get) => (threadRef, promotedTo) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey) {
      return;
    }
    set((state) => {
      const existing = state.draftThreadsByThreadKey[threadKey];
      if (!existing) {
        return state;
      }
      const nextPromotedTo =
        promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId);
      if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo)) {
        return state;
      }
      return {
        draftThreadsByThreadKey: {
          ...state.draftThreadsByThreadKey,
          [threadKey]: {
            ...existing,
            promotedTo: nextPromotedTo,
          },
        },
      };
    });
  };

const finalizePromotedDraftThread: ComposerDraftActionBuilder<"finalizePromotedDraftThread"> =
  (set, get) => (threadRef) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const existing = state.draftThreadsByThreadKey[threadKey];
      if (!isDraftThreadPromoting(existing)) {
        return state;
      }
      return removeDraftThreadReferences(state, threadKey);
    });
  };

const clearDraftThread: ComposerDraftActionBuilder<"clearDraftThread"> =
  (set, get) => (threadRef) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined;
      const hasLogicalProjectMapping = Object.values(
        state.logicalProjectDraftThreadKeyByLogicalProjectKey,
      ).includes(threadKey);
      const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined;
      if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft) {
        return state;
      }
      return removeDraftThreadReferences(state, threadKey);
    });
  };

/** Create, re-target, promote and remove pre-thread draft sessions. */
export const sessionActions = {
  setLogicalProjectDraftThreadId,
  setProjectDraftThreadId,
  setDraftThreadContext,
  clearProjectDraftThreadId,
  clearProjectDraftThreadById,
  markDraftThreadPromoting,
  finalizePromotedDraftThread,
  clearDraftThread,
};
