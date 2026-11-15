import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderOptionSelection,
} from "@loop/contracts";
import * as Equal from "effect/Equal";
import { createModelSelection, normalizeModelSlug } from "@loop/shared/model";
import { createEmptyThreadDraft, withDraft } from "./draftContent";
import { normalizeModelSelection, normalizeProviderDriverKind } from "./modelSelectionNormalize";
import { isRuntimeMode } from "./schema";
import { resolveComposerDraftKey } from "./targets";
import type {
  ComposerDraftActionBuilder,
  ComposerDraftStoreState,
  ComposerThreadDraftState,
} from "./types";

type ModelSelectionByProvider = Partial<Record<ProviderInstanceId, ModelSelection>>;

const setStickyModelSelection: ComposerDraftActionBuilder<"setStickyModelSelection"> =
  (set) => (modelSelection) => {
    const normalized = normalizeModelSelection(modelSelection);
    set((state) => {
      if (!normalized) {
        return state;
      }
      const nextMap: ModelSelectionByProvider = {
        ...state.stickyModelSelectionByProvider,
        [normalized.instanceId]: normalized,
      };
      if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
        return state.stickyActiveProvider === normalized.instanceId
          ? state
          : { stickyActiveProvider: normalized.instanceId };
      }
      return {
        stickyModelSelectionByProvider: nextMap,
        stickyActiveProvider: normalized.instanceId,
      };
    });
  };

const applyStickyState: ComposerDraftActionBuilder<"applyStickyState"> =
  (set, get) => (threadRef) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const stickyMap = state.stickyModelSelectionByProvider;
      const stickyActiveProvider = state.stickyActiveProvider;
      if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
        return state;
      }
      const existing = state.draftsByThreadKey[threadKey];
      const base = existing ?? createEmptyThreadDraft();
      const nextMap = { ...base.modelSelectionByProvider };
      for (const [provider, selection] of Object.entries(stickyMap)) {
        if (selection) {
          // Iteration key comes from the instance-keyed sticky map,
          // so coerce the string back to `ProviderInstanceId` for
          // the typed lookup.
          const instanceKey = provider as ProviderInstanceId;
          const current = nextMap[instanceKey];
          nextMap[instanceKey] = {
            ...selection,
            model: current?.model ?? selection.model,
          };
        }
      }
      if (
        Equal.equals(base.modelSelectionByProvider, nextMap) &&
        base.activeProvider === stickyActiveProvider
      ) {
        return state;
      }
      return withDraft(state, threadKey, {
        ...base,
        modelSelectionByProvider: nextMap,
        activeProvider: stickyActiveProvider,
      });
    });
  };

const setModelSelection: ComposerDraftActionBuilder<"setModelSelection"> =
  (set, get) => (threadRef, modelSelection, opts) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    const normalized = normalizeModelSelection(modelSelection);
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey];
      if (!existing && normalized === null) {
        return state;
      }
      const base = existing ?? createEmptyThreadDraft();
      const nextMap = { ...base.modelSelectionByProvider };
      if (normalized) {
        const current = nextMap[normalized.instanceId];
        if (normalized.options !== undefined || opts?.replaceOptions) {
          // Explicit options provided (or the caller passed a complete
          // snapshot whose absent options mean "no options") → use the
          // selection as-is.
          nextMap[normalized.instanceId] = normalized as ModelSelection;
        } else {
          // No options in selection → preserve existing options, update provider+model
          nextMap[normalized.instanceId] = createModelSelection(
            normalized.instanceId,
            normalized.model,
            current?.options,
          );
        }
      }
      const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;
      if (
        Equal.equals(base.modelSelectionByProvider, nextMap) &&
        base.activeProvider === nextActiveProvider
      ) {
        return state;
      }
      return withDraft(state, threadKey, {
        ...base,
        modelSelectionByProvider: nextMap,
        activeProvider: nextActiveProvider,
      });
    });
  };

const setModelOptions: ComposerDraftActionBuilder<"setModelOptions"> =
  (set, get) => (threadRef, modelOptions) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey];
      if (!existing && (!modelOptions || Object.keys(modelOptions).length === 0)) {
        return state;
      }
      const base = existing ?? createEmptyThreadDraft();
      const nextMap = { ...base.modelSelectionByProvider };
      for (const provider of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
        if (!modelOptions || !(provider in modelOptions)) continue;
        const opts = modelOptions[provider];
        const driverKind = ProviderDriverKind.make(provider);
        const instanceKey = defaultInstanceIdForDriver(driverKind);
        const current = nextMap[instanceKey];
        if (opts && opts.length > 0) {
          nextMap[instanceKey] = createModelSelection(
            instanceKey,
            current?.model ?? DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL,
            opts,
          );
        } else if (current?.options) {
          const { options: _, ...rest } = current;
          nextMap[instanceKey] = rest as ModelSelection;
        }
      }
      if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
        return state;
      }
      return withDraft(state, threadKey, { ...base, modelSelectionByProvider: nextMap });
    });
  };

interface ProviderOptionsUpdate {
  instanceKey: ProviderInstanceId;
  fallbackModel: string;
  providerOpts: ReadonlyArray<ProviderOptionSelection> | undefined;
}

/** Sets (or strips) one instance's options on a selection map, keeping its model. */
function withProviderOptions(
  map: ModelSelectionByProvider,
  instanceKey: ProviderInstanceId,
  current: ModelSelection,
  providerOpts: ReadonlyArray<ProviderOptionSelection> | undefined,
): void {
  if (providerOpts) {
    map[instanceKey] = createModelSelection(instanceKey, current.model, providerOpts);
  } else if ((current.options?.length ?? 0) > 0) {
    const { options: _, ...rest } = current;
    map[instanceKey] = rest as ModelSelection;
  }
}

function nextDraftProviderMap(
  base: ComposerThreadDraftState,
  { instanceKey, fallbackModel, providerOpts }: ProviderOptionsUpdate,
): ModelSelectionByProvider {
  const nextMap = { ...base.modelSelectionByProvider };
  const currentForProvider = nextMap[instanceKey];
  if (providerOpts) {
    nextMap[instanceKey] = createModelSelection(
      instanceKey,
      currentForProvider?.model ?? fallbackModel,
      providerOpts,
    );
  } else if (currentForProvider) {
    withProviderOptions(nextMap, instanceKey, currentForProvider, providerOpts);
  }
  return nextMap;
}

function nextStickyProviderState(
  state: ComposerDraftStoreState,
  base: ComposerThreadDraftState,
  { instanceKey, fallbackModel, providerOpts }: ProviderOptionsUpdate,
  explicitInstance: boolean,
): Pick<ComposerDraftStoreState, "stickyModelSelectionByProvider" | "stickyActiveProvider"> {
  const nextStickyMap = { ...state.stickyModelSelectionByProvider };
  const stickyBase =
    nextStickyMap[instanceKey] ??
    base.modelSelectionByProvider[instanceKey] ??
    createModelSelection(instanceKey, fallbackModel);
  withProviderOptions(nextStickyMap, instanceKey, stickyBase, providerOpts);
  return {
    stickyModelSelectionByProvider: nextStickyMap,
    stickyActiveProvider: explicitInstance ? instanceKey : (base.activeProvider ?? instanceKey),
  };
}

const setProviderModelOptions: ComposerDraftActionBuilder<"setProviderModelOptions"> =
  (set, get) => (threadRef, provider, nextProviderOptions, options) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    const normalizedProvider = normalizeProviderDriverKind(provider);
    if (normalizedProvider === null) {
      return;
    }
    const update: ProviderOptionsUpdate = {
      instanceKey: options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider),
      fallbackModel:
        normalizeModelSlug(options?.model, normalizedProvider) ??
        DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
        DEFAULT_MODEL,
      providerOpts:
        nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined,
    };

    set((state) => {
      const base = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      const nextMap = nextDraftProviderMap(base, update);
      // Handle sticky persistence
      const sticky =
        options?.persistSticky === true
          ? nextStickyProviderState(state, base, update, Boolean(options.instanceId))
          : {
              stickyModelSelectionByProvider: state.stickyModelSelectionByProvider,
              stickyActiveProvider: state.stickyActiveProvider,
            };

      if (
        Equal.equals(base.modelSelectionByProvider, nextMap) &&
        Equal.equals(state.stickyModelSelectionByProvider, sticky.stickyModelSelectionByProvider) &&
        state.stickyActiveProvider === sticky.stickyActiveProvider
      ) {
        return state;
      }

      const nextDraft: ComposerThreadDraftState = {
        ...base,
        ...(options?.instanceId ? { activeProvider: update.instanceKey } : {}),
        modelSelectionByProvider: nextMap,
      };
      return {
        ...withDraft(state, threadKey, nextDraft),
        ...(options?.persistSticky === true ? sticky : {}),
      };
    });
  };

const setRuntimeMode: ComposerDraftActionBuilder<"setRuntimeMode"> =
  (set, get) => (threadRef, runtimeMode) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null;
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey];
      if (!existing && nextRuntimeMode === null) {
        return state;
      }
      const base = existing ?? createEmptyThreadDraft();
      if (base.runtimeMode === nextRuntimeMode) {
        return state;
      }
      return withDraft(state, threadKey, { ...base, runtimeMode: nextRuntimeMode });
    });
  };

const setInteractionMode: ComposerDraftActionBuilder<"setInteractionMode"> =
  (set, get) => (threadRef, interactionMode) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    const nextInteractionMode =
      interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey];
      if (!existing && nextInteractionMode === null) {
        return state;
      }
      const base = existing ?? createEmptyThreadDraft();
      if (base.interactionMode === nextInteractionMode) {
        return state;
      }
      return withDraft(state, threadKey, { ...base, interactionMode: nextInteractionMode });
    });
  };

/** Model, provider-option, runtime-mode and interaction-mode selection, plus sticky defaults. */
export const modelActions = {
  setStickyModelSelection,
  applyStickyState,
  setModelSelection,
  setModelOptions,
  setProviderModelOptions,
  setRuntimeMode,
  setInteractionMode,
};
