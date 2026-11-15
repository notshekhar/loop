// The composer draft store lives in ./composerDraftStore/; this file keeps the
// public import path stable for the many modules that read drafts.
export {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  type DraftThreadEnvMode,
  PersistedComposerImageAttachment,
} from "./composerDraftStore/schema";
export type {
  ComposerImageAttachment,
  ComposerThreadDraftState,
  DraftSessionState,
  DraftThreadState,
  EffectiveComposerModelState,
} from "./composerDraftStore/types";
export { createEmptyThreadDraft } from "./composerDraftStore/draftContent";
export { deriveEffectiveComposerModelState } from "./composerDraftStore/effectiveModelState";
export { hydrateImagesFromPersisted } from "./composerDraftStore/hydration";
export { useComposerDraftStore } from "./composerDraftStore/store";
export {
  useComposerDraftModelState,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "./composerDraftStore/hooks";
export {
  clearComposerDraftsEnvironment,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThread,
  markPromotedDraftThreadByRef,
  markPromotedDraftThreads,
  markPromotedDraftThreadsByRef,
} from "./composerDraftStore/serverLifecycle";
