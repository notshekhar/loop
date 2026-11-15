import type { ProviderInstanceId } from "@loop/contracts";
import type { ClientSettings } from "@loop/contracts/settings";
import { resolveSelectableModel } from "@loop/shared/model";
import { useCallback } from "react";
import { useUpdateClientSettings } from "~/hooks/useSettings";
import { parseModelPickerLegacySectionKey, parseModelPickerModelKey } from "../modelPickerKeys";
import type { ModelEsque } from "../providerIconUtils";
import type { ProviderInstanceEntry } from "../../../providerInstances";

interface ModelPickerActionsInput {
  favorites: ClientSettings["favorites"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  entryByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderInstanceEntry>;
  getModelDisabledReason:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  toggleLegacySection: (instanceId: ProviderInstanceId) => void;
}

function useHandleModelSelect(input: ModelPickerActionsInput) {
  const { entryByInstanceId, getModelDisabledReason, modelOptionsByInstance } = input;
  const { onInstanceModelChange } = input;
  return useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId) => {
      if (getModelDisabledReason?.(instanceId, modelSlug)) {
        return;
      }
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (resolvedModel) {
        onInstanceModelChange(instanceId, resolvedModel);
      }
    },
    [entryByInstanceId, getModelDisabledReason, modelOptionsByInstance, onInstanceModelChange],
  );
}

function useToggleFavorite(favorites: ClientSettings["favorites"]) {
  const updateSettings = useUpdateClientSettings();
  return useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === instanceId && f.model === model);
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider: instanceId, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [favorites, updateSettings],
  );
}

/** Picking a model, toggling a favorite, and activating a list key (model or legacy fold). */
export function useModelPickerActions(input: ModelPickerActionsInput) {
  const handleModelSelect = useHandleModelSelect(input);
  const toggleFavorite = useToggleFavorite(input.favorites);
  const { toggleLegacySection } = input;
  // Both the combobox's value change and Enter in the search box land here.
  const activateItem = (modelKey: string) => {
    const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
    if (legacyInstanceId) {
      toggleLegacySection(legacyInstanceId);
      return;
    }
    const model = parseModelPickerModelKey(modelKey);
    if (model) {
      handleModelSelect(model.slug, model.instanceId);
    }
  };
  return { handleModelSelect, toggleFavorite, activateItem };
}
