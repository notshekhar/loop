import { type EnvironmentId, ModelSelection, ProviderInstanceId, ThreadId } from "@loop/contracts";
import { parseScopedThreadKey } from "@loop/runtime/environment";
import { DeepMutable } from "effect/Types";
import { ensureInlineTerminalContextPlaceholders } from "../lib/terminalContext";
import {
  compactModelSelectionByProvider,
  migrateLegacyModelSelection,
  normalizeModelSelection,
  normalizeProviderInstanceId,
  normalizeProviderModelOptions,
} from "./modelSelectionNormalize";
import {
  normalizePersistedAttachment,
  normalizePersistedElementContextDraft,
  normalizePersistedTerminalContextDraft,
} from "./persistedEntries";
import {
  isReviewCommentContext,
  isRuntimeMode,
  type LegacyPersistedComposerThreadDraftState,
  type PersistedComposerDraftStoreState,
  type PersistedComposerThreadDraftState,
} from "./schema";
import { composerThreadRefFromKey, normalizeLegacyComposerStorageKey } from "./targets";

type PersistedDraftsByThreadKey = PersistedComposerDraftStoreState["draftsByThreadKey"];
type PersistedDraftThreadsByThreadKey = PersistedComposerDraftStoreState["draftThreadsByThreadKey"];

interface PersistedDraftModelState {
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  activeProvider: ProviderInstanceId | null;
}

function normalizeEntries<T>(value: unknown, normalize: (entry: unknown) => T | null): T[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const normalized = normalize(entry);
        return normalized ? [normalized] : [];
      })
    : [];
}

function environmentIdsFromDraftThreads(
  draftThreadsByThreadKey: PersistedDraftThreadsByThreadKey,
): Map<ThreadId, EnvironmentId> {
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  for (const [threadKey, draftThread] of Object.entries(draftThreadsByThreadKey)) {
    const parsedThreadRef = composerThreadRefFromKey(threadKey);
    if (!parsedThreadRef) {
      continue;
    }
    environmentIdByThreadId.set(
      parsedThreadRef.threadId,
      draftThread.environmentId as EnvironmentId,
    );
  }
  return environmentIdByThreadId;
}

function normalizePersistedDraftModelState(draftValue: object): PersistedDraftModelState {
  const draftCandidate = draftValue as PersistedComposerThreadDraftState;
  // If the draft already has the v3 shape, use it directly
  const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
  if (
    draftCandidate.modelSelectionByProvider &&
    typeof draftCandidate.modelSelectionByProvider === "object"
  ) {
    // v3 format
    return {
      modelSelectionByProvider: draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >,
      activeProvider: normalizeProviderInstanceId(draftCandidate.activeProvider),
    };
  }
  // v2 or legacy format: migrate
  const normalizedModelOptions =
    normalizeProviderModelOptions(
      legacyDraftCandidate.modelOptions,
      undefined,
      legacyDraftCandidate,
    ) ?? null;
  const normalizedModelSelection = normalizeModelSelection(legacyDraftCandidate.modelSelection, {
    provider: legacyDraftCandidate.provider,
    model: legacyDraftCandidate.model,
    modelOptions: normalizedModelOptions ?? (legacyDraftCandidate.modelOptions as unknown),
    legacyCodex: legacyDraftCandidate,
  });
  const { modelSelection, modelSelectionByProvider } = migrateLegacyModelSelection(
    normalizedModelSelection,
    normalizedModelOptions,
  );
  return { modelSelectionByProvider, activeProvider: modelSelection?.instanceId ?? null };
}

/** Returns null for a draft with nothing worth keeping. */
function normalizePersistedDraft(
  draftValue: object,
): DeepMutable<PersistedComposerThreadDraftState> | null {
  const draftCandidate = draftValue as PersistedComposerThreadDraftState;
  const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
  const attachments = normalizeEntries(draftCandidate.attachments, normalizePersistedAttachment);
  const terminalContexts = normalizeEntries(
    draftCandidate.terminalContexts,
    normalizePersistedTerminalContextDraft,
  );
  const elementContexts = normalizeEntries(
    draftCandidate.elementContexts,
    normalizePersistedElementContextDraft,
  );
  const reviewComments = Array.isArray(draftCandidate.reviewComments)
    ? draftCandidate.reviewComments.filter(isReviewCommentContext)
    : [];
  const runtimeMode = isRuntimeMode(draftCandidate.runtimeMode) ? draftCandidate.runtimeMode : null;
  const interactionMode =
    draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
      ? draftCandidate.interactionMode
      : null;
  const prompt = ensureInlineTerminalContextPlaceholders(promptCandidate, terminalContexts.length);
  const { modelSelectionByProvider, activeProvider } =
    normalizePersistedDraftModelState(draftValue);

  const hasModelData = Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
  if (
    promptCandidate.length === 0 &&
    attachments.length === 0 &&
    terminalContexts.length === 0 &&
    elementContexts.length === 0 &&
    reviewComments.length === 0 &&
    !hasModelData &&
    !runtimeMode &&
    !interactionMode
  ) {
    return null;
  }
  return {
    prompt,
    attachments,
    ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
    ...(elementContexts.length > 0 ? { elementContexts } : {}),
    ...(reviewComments.length > 0 ? { reviewComments } : {}),
    ...(hasModelData
      ? {
          modelSelectionByProvider: compactModelSelectionByProvider(modelSelectionByProvider),
          activeProvider,
        }
      : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
    ...(interactionMode ? { interactionMode } : {}),
  };
}

function resolvePersistedDraftThreadKey(
  threadKeyOrId: string,
  draftThreadsByThreadKey: PersistedDraftThreadsByThreadKey,
  environmentIdByThreadId: Map<ThreadId, EnvironmentId>,
): string {
  if (parseScopedThreadKey(threadKeyOrId) !== null) {
    return normalizeLegacyComposerStorageKey(threadKeyOrId);
  }
  if (draftThreadsByThreadKey[threadKeyOrId] !== undefined) {
    return threadKeyOrId;
  }
  const environmentId = environmentIdByThreadId.get(threadKeyOrId as ThreadId);
  return environmentId
    ? normalizeLegacyComposerStorageKey(threadKeyOrId, { environmentId })
    : threadKeyOrId;
}

export function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
  draftThreadsByThreadKey: PersistedDraftThreadsByThreadKey,
): PersistedDraftsByThreadKey {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const environmentIdByThreadId = environmentIdsFromDraftThreads(draftThreadsByThreadKey);
  const nextDraftsByThreadKey: DeepMutable<PersistedDraftsByThreadKey> = {};
  for (const [threadKeyOrId, draftValue] of Object.entries(
    rawDraftMap as Record<string, unknown>,
  )) {
    if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draft = normalizePersistedDraft(draftValue);
    if (!draft) {
      continue;
    }
    const normalizedThreadKey = resolvePersistedDraftThreadKey(
      threadKeyOrId,
      draftThreadsByThreadKey,
      environmentIdByThreadId,
    );
    nextDraftsByThreadKey[normalizedThreadKey] = draft;
  }

  return nextDraftsByThreadKey;
}
