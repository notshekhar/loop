import {
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
} from "@loop/contracts";
import { normalizeModelSlug } from "@loop/shared/model";
import { UnifiedSettings } from "@loop/contracts/settings";
import { resolveAppModelSelection, resolveAppModelSelectionForInstance } from "../modelSelection";
import { getDefaultServerModel } from "../providerModels";
import type { ProviderOptionSelectionsByProvider } from "./schema";
import type { ComposerThreadDraftState, EffectiveComposerModelState } from "./types";

export interface EffectiveComposerModelInput {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * Optional routing key of the instance whose selection should override
   * the driver-level lookup. When present, the draft is queried by
   * `modelSelectionByProvider[selectedInstanceId]` so a custom Codex
   * instance (e.g. `codex_personal`) reads its own saved model instead of
   * collapsing to the default Codex bucket.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}

function providerSelectionsFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection) {
    return null;
  }
  const options = modelSelection.options;
  if (!options || options.length === 0) {
    return null;
  }
  return { [modelSelection.instanceId]: options };
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function resolveBaseModel(input: EffectiveComposerModelInput): string {
  const baseModelCandidate =
    input.threadModelSelection?.model ?? input.projectModelSelection?.model ?? null;
  return (
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
        )
      : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider)
  );
}

function resolveSelectedModel(input: EffectiveComposerModelInput, baseModel: string): string {
  // Look up the instance's saved selection first; fall back to the
  // driver-kind bucket so legacy kind-keyed drafts still resolve. Every
  // `ProviderDriverKind` literal is a valid `ProviderInstanceId` slug, so the
  // cast to the branded type is safe.
  const instanceSelection = input.selectedInstanceId
    ? input.draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  const legacySelection =
    input.draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);
  return activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
      ) ??
        resolveAppModelSelection(
          input.selectedProvider,
          input.settings,
          input.providers,
          activeSelection.model,
        ))
    : baseModel;
}

export function deriveEffectiveComposerModelState(
  input: EffectiveComposerModelInput,
): EffectiveComposerModelState {
  const baseModel = resolveBaseModel(input);
  const selectedModel = resolveSelectedModel(input, baseModel);
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerSelectionsFromModelSelection(input.threadModelSelection) ??
    providerSelectionsFromModelSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}
