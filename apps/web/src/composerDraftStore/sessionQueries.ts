import { scopedThreadKey, scopeThreadRef } from "@loop/runtime/environment";
import { isDraftThreadPromoting, toProjectDraftSession } from "./draftSessions";
import { DraftId } from "./schema";
import { getComposerDraftState, logicalProjectDraftKey } from "./targets";
import type { ComposerDraftActionBuilder } from "./types";

const getComposerDraft: ComposerDraftActionBuilder<"getComposerDraft"> = (_set, get) => (target) =>
  getComposerDraftState(get(), target);

const getDraftThreadByLogicalProjectKey: ComposerDraftActionBuilder<
  "getDraftThreadByLogicalProjectKey"
> = (_set, get) => (logicalProjectKey) => {
  return get().getDraftSessionByLogicalProjectKey(logicalProjectKey);
};

const getDraftSessionByLogicalProjectKey: ComposerDraftActionBuilder<
  "getDraftSessionByLogicalProjectKey"
> = (_set, get) => (logicalProjectKey) => {
  const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
  if (normalizedLogicalProjectKey.length === 0) {
    return null;
  }
  const draftId =
    get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
  if (!draftId) {
    return null;
  }
  const draftThread = get().draftThreadsByThreadKey[draftId];
  if (!draftThread || isDraftThreadPromoting(draftThread)) {
    return null;
  }
  return toProjectDraftSession(DraftId.make(draftId), draftThread);
};

const getDraftThreadByProjectRef: ComposerDraftActionBuilder<"getDraftThreadByProjectRef"> =
  (_set, get) => (projectRef) => {
    return get().getDraftSessionByProjectRef(projectRef);
  };

const getDraftSessionByProjectRef: ComposerDraftActionBuilder<"getDraftSessionByProjectRef"> =
  (_set, get) => (projectRef) => {
    for (const [draftId, draftThread] of Object.entries(get().draftThreadsByThreadKey)) {
      if (isDraftThreadPromoting(draftThread)) {
        continue;
      }
      if (
        draftThread.projectId === projectRef.projectId &&
        draftThread.environmentId === projectRef.environmentId
      ) {
        return toProjectDraftSession(DraftId.make(draftId), draftThread);
      }
    }
    return null;
  };

const getDraftSession: ComposerDraftActionBuilder<"getDraftSession"> = (_set, get) => (draftId) =>
  get().draftThreadsByThreadKey[draftId] ?? null;

const getDraftSessionByRef: ComposerDraftActionBuilder<"getDraftSessionByRef"> =
  (_set, get) => (threadRef) => {
    for (const draftSession of Object.values(get().draftThreadsByThreadKey)) {
      if (
        draftSession.environmentId === threadRef.environmentId &&
        draftSession.threadId === threadRef.threadId
      ) {
        return draftSession;
      }
    }
    return null;
  };

const getDraftThread: ComposerDraftActionBuilder<"getDraftThread"> = (_set, get) => (threadRef) => {
  if (typeof threadRef === "string") {
    return get().getDraftSession(DraftId.make(threadRef));
  }
  return get().getDraftSessionByRef(threadRef);
};

const getDraftThreadByRef: ComposerDraftActionBuilder<"getDraftThreadByRef"> =
  (_set, get) => (threadRef) => {
    return get().getDraftSessionByRef(threadRef);
  };

const listDraftThreadKeys: ComposerDraftActionBuilder<"listDraftThreadKeys"> = (_set, get) => () =>
  Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
    scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
  );

const hasDraftThreadsInEnvironment: ComposerDraftActionBuilder<"hasDraftThreadsInEnvironment"> =
  (_set, get) => (environmentId) =>
    Object.values(get().draftThreadsByThreadKey).some(
      (draftThread) => draftThread.environmentId === environmentId,
    );

/** Read-only lookups over draft content and draft sessions. */
export const sessionQueryActions = {
  getComposerDraft,
  getDraftThreadByLogicalProjectKey,
  getDraftSessionByLogicalProjectKey,
  getDraftThreadByProjectRef,
  getDraftSessionByProjectRef,
  getDraftSession,
  getDraftSessionByRef,
  getDraftThread,
  getDraftThreadByRef,
  listDraftThreadKeys,
  hasDraftThreadsInEnvironment,
};
