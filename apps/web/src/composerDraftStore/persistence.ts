import { ModelSelection, type PreviewAnnotationPayload, ProviderInstanceId } from "@loop/contracts";
import { DeepMutable } from "effect/Types";
import { createJSONStorage, type PersistOptions } from "zustand/middleware";
import { toHydratedDraftThreadState, toHydratedThreadDraft } from "./hydration";
import {
  compactModelSelectionByProvider,
  migrateLegacyModelSelection,
  normalizeModelSelection,
  normalizeProviderInstanceId,
  normalizeProviderModelOptions,
} from "./modelSelectionNormalize";
import { normalizePersistedDraftThreads } from "./persistedDraftThreads";
import { normalizePersistedDraftsByThreadId } from "./persistedDrafts";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  type LegacyPersistedComposerDraftStoreState,
  type PersistedComposerDraftStoreState,
  type PersistedComposerThreadDraftState,
} from "./schema";
import { composerDebouncedStorage } from "./storage";
import type { ComposerDraftStoreState, ComposerThreadDraftState, DraftThreadState } from "./types";

const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
});

type ModelSelectionByProvider = Partial<Record<ProviderInstanceId, ModelSelection>>;

/** Older storage versions named the three store maps differently; read whichever is present. */
function readLegacyStoreMaps(candidate: LegacyPersistedComposerDraftStoreState) {
  return {
    rawDraftMap: candidate.draftsByThreadKey ?? candidate.draftsByThreadId,
    rawDraftThreadsByThreadId:
      candidate.draftThreadsByThreadKey ?? candidate.draftThreadsByThreadId,
    rawProjectDraftThreadIdByProjectKey:
      candidate.logicalProjectDraftThreadKeyByLogicalProjectKey ??
      candidate.projectDraftThreadKeyByProjectKey ??
      candidate.projectDraftThreadIdByProjectKey ??
      candidate.projectDraftThreadIdByProjectId,
  };
}

/** Migrate sticky state from v2 (dual) to v3 (consolidated). */
function legacyStickyModelSelectionByProvider(
  candidate: LegacyPersistedComposerDraftStoreState,
  provider: unknown,
): ModelSelectionByProvider {
  const stickyModelOptions = normalizeProviderModelOptions(candidate.stickyModelOptions) ?? {};
  const normalizedStickyModelSelection = normalizeModelSelection(candidate.stickyModelSelection, {
    provider,
    model: candidate.stickyModel,
    modelOptions: stickyModelOptions,
  });
  return migrateLegacyModelSelection(normalizedStickyModelSelection, stickyModelOptions)
    .modelSelectionByProvider;
}

function normalizePersistedStoreMaps(
  candidate: LegacyPersistedComposerDraftStoreState,
): Pick<
  PersistedComposerDraftStoreState,
  | "draftsByThreadKey"
  | "draftThreadsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const { rawDraftMap, rawDraftThreadsByThreadId, rawProjectDraftThreadIdByProjectKey } =
    readLegacyStoreMaps(candidate);
  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(rawDraftThreadsByThreadId, rawProjectDraftThreadIdByProjectKey);
  const draftsByThreadKey = normalizePersistedDraftsByThreadId(
    rawDraftMap,
    draftThreadsByThreadKey,
  );
  return {
    draftsByThreadKey,
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
  };
}

function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const candidate = persistedState as LegacyPersistedComposerDraftStoreState;
  const stickyModelSelectionByProvider = legacyStickyModelSelectionByProvider(
    candidate,
    candidate.stickyProvider ?? "codex",
  );
  const stickyActiveProvider = normalizeProviderInstanceId(candidate.stickyProvider) ?? null;
  return {
    ...normalizePersistedStoreMaps(candidate),
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  };
}

function hasPersistableDraftContent(draft: ComposerThreadDraftState): boolean {
  const hasModelData =
    Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
  return !(
    draft.prompt.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.elementContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    draft.reviewComments.length === 0 &&
    !hasModelData &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

function toPersistedContexts(
  draft: ComposerThreadDraftState,
): Pick<DeepMutable<PersistedComposerThreadDraftState>, "terminalContexts" | "elementContexts"> {
  return {
    ...(draft.terminalContexts.length > 0
      ? {
          terminalContexts: draft.terminalContexts.map((context) => ({
            id: context.id,
            threadId: context.threadId,
            createdAt: context.createdAt,
            terminalId: context.terminalId,
            terminalLabel: context.terminalLabel,
            lineStart: context.lineStart,
            lineEnd: context.lineEnd,
          })),
        }
      : {}),
    ...(draft.elementContexts.length > 0
      ? {
          elementContexts: draft.elementContexts.map((context) => ({
            id: context.id,
            threadId: context.threadId,
            pickedAt: context.pickedAt,
            pageUrl: context.pageUrl,
            pageTitle: context.pageTitle,
            tagName: context.tagName,
            selector: context.selector,
            htmlPreview: context.htmlPreview,
            componentName: context.componentName,
            source: context.source,
            styles: context.styles,
          })),
        }
      : {}),
  };
}

function toPersistedDraft(
  draft: ComposerThreadDraftState,
): DeepMutable<PersistedComposerThreadDraftState> {
  const hasModelData =
    Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
  return {
    prompt: draft.prompt,
    attachments: draft.persistedAttachments,
    ...toPersistedContexts(draft),
    ...(draft.previewAnnotations.length > 0
      ? {
          previewAnnotations: draft.previewAnnotations.map(
            (annotation) => ({ ...annotation }) as DeepMutable<PreviewAnnotationPayload>,
          ),
        }
      : {}),
    ...(draft.reviewComments.length > 0
      ? {
          reviewComments: draft.reviewComments.map((comment) => ({ ...comment })),
        }
      : {}),
    ...(hasModelData
      ? {
          modelSelectionByProvider: compactModelSelectionByProvider(draft.modelSelectionByProvider),
          activeProvider: draft.activeProvider,
        }
      : {}),
    ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
    ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
  };
}

function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const persistedDraftsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadKey"]
  > = {};
  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
    if (typeof threadKey !== "string" || threadKey.length === 0) {
      continue;
    }
    if (!hasPersistableDraftContent(draft)) {
      continue;
    }
    persistedDraftsByThreadKey[threadKey] = toPersistedDraft(draft);
  }
  return {
    draftsByThreadKey: persistedDraftsByThreadKey,
    draftThreadsByThreadKey: state.draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

// Handle both v3 (modelSelectionByProvider) and v2/legacy formats
function normalizePersistedStickyState(candidate: LegacyPersistedComposerDraftStoreState): {
  stickyModelSelectionByProvider: ModelSelectionByProvider;
  stickyActiveProvider: ProviderInstanceId | null;
} {
  if (
    candidate.stickyModelSelectionByProvider &&
    typeof candidate.stickyModelSelectionByProvider === "object"
  ) {
    return {
      stickyModelSelectionByProvider:
        candidate.stickyModelSelectionByProvider as ModelSelectionByProvider,
      stickyActiveProvider: normalizeProviderInstanceId(candidate.stickyActiveProvider),
    };
  }
  // Legacy migration path
  return {
    stickyModelSelectionByProvider: legacyStickyModelSelectionByProvider(
      candidate,
      candidate.stickyProvider,
    ),
    stickyActiveProvider: normalizeProviderInstanceId(candidate.stickyProvider),
  };
}

function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { stickyModelSelectionByProvider, stickyActiveProvider } =
    normalizePersistedStickyState(normalizedPersistedState);
  return {
    ...normalizePersistedStoreMaps(normalizedPersistedState),
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  };
}

function mergePersistedComposerDraftStoreState(
  persistedState: unknown,
  currentState: ComposerDraftStoreState,
): ComposerDraftStoreState {
  const normalizedPersisted = normalizeCurrentPersistedComposerDraftStoreState(persistedState);
  const draftsByThreadKey = Object.fromEntries(
    Object.entries(normalizedPersisted.draftsByThreadKey).map(([threadKey, draft]) => [
      threadKey,
      toHydratedThreadDraft(draft),
    ]),
  );
  const draftThreadsByThreadKey = Object.fromEntries(
    Object.entries(normalizedPersisted.draftThreadsByThreadKey).map(([threadKey, draftThread]) => [
      threadKey,
      toHydratedDraftThreadState(draftThread),
    ]),
  ) as Record<string, DraftThreadState>;
  return {
    ...currentState,
    draftsByThreadKey,
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      normalizedPersisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
    stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
  };
}

export const composerDraftPersistOptions = {
  name: COMPOSER_DRAFT_STORAGE_KEY,
  version: COMPOSER_DRAFT_STORAGE_VERSION,
  storage: createJSONStorage(() => composerDebouncedStorage),
  migrate: migratePersistedComposerDraftStoreState,
  partialize: partializeComposerDraftStoreState,
  merge: mergePersistedComposerDraftStoreState,
} satisfies PersistOptions<ComposerDraftStoreState, PersistedComposerDraftStoreState>;
