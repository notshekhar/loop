import type { ProviderInstanceId, ProviderDriverKind } from "@loop/contracts";
import { useCallback, useMemo, useState } from "react";
import { modelPickerLegacySectionKey, modelPickerModelKey } from "../modelPickerKeys";
import type { ModelEsque } from "../providerIconUtils";
import {
  browseModelPickerItems,
  buildLegacySection,
  type LockedProviderMatcher,
  type ModelPickerItem,
  type ModelPickerSelection,
  searchModelPickerItems,
} from "./modelPickerItems";

interface ModelPickerListInput {
  flatModels: ModelPickerItem[];
  searchQuery: string;
  selectedInstanceId: ModelPickerSelection;
  favoritesSet: ReadonlySet<string>;
  instanceOrder: ReadonlyArray<ProviderInstanceId>;
  lockedProvider: ProviderDriverKind | null;
  matchesLockedProvider: LockedProviderMatcher;
  activeInstanceId: ProviderInstanceId;
  model: string;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}

/** Legacy-model folds start open for the active instance when its current model is legacy. */
function useExpandedLegacyInstances(input: ModelPickerListInput) {
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        input.modelOptionsByInstance
          .get(input.activeInstanceId)
          ?.some((model) => model.slug === input.model && model.isLegacy)
          ? [input.activeInstanceId]
          : [],
      ),
  );
  const toggleLegacySection = useCallback((instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  }, []);
  return { expandedLegacyInstances, toggleLegacySection };
}

function useFilteredModels(input: ModelPickerListInput): ModelPickerItem[] {
  const {
    favoritesSet,
    flatModels,
    instanceOrder,
    matchesLockedProvider,
    lockedProvider,
    searchQuery,
    selectedInstanceId,
  } = input;
  // Filter models based on search query and selected instance
  return useMemo(() => {
    const lockedProviderMatcher = lockedProvider !== null ? matchesLockedProvider : null;
    if (searchQuery.trim()) {
      return searchModelPickerItems(flatModels, searchQuery, favoritesSet, lockedProviderMatcher);
    }
    return browseModelPickerItems(
      flatModels,
      selectedInstanceId,
      favoritesSet,
      instanceOrder,
      lockedProviderMatcher,
    );
  }, [
    favoritesSet,
    flatModels,
    instanceOrder,
    matchesLockedProvider,
    lockedProvider,
    searchQuery,
    selectedInstanceId,
  ]);
}

/** The combobox's item keys: every model plus one key per legacy fold. */
function useAllItemKeys(flatModels: ModelPickerItem[]): string[] {
  return useMemo(
    (): string[] => [
      ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
      ...new Set(
        flatModels
          .filter((model) => model.isLegacy)
          .map((model) => modelPickerLegacySectionKey(model.instanceId)),
      ),
    ],
    [flatModels],
  );
}

export function useModelPickerList(input: ModelPickerListInput) {
  const { selectedInstanceId } = input;
  const isSearching = input.searchQuery.trim().length > 0;
  const { expandedLegacyInstances, toggleLegacySection } = useExpandedLegacyInstances(input);
  const filteredModels = useFilteredModels(input);

  const legacySection = useMemo(() => {
    if (isSearching || selectedInstanceId === "favorites") {
      return null;
    }
    return buildLegacySection(filteredModels, selectedInstanceId, expandedLegacyInstances);
  }, [expandedLegacyInstances, filteredModels, isSearching, selectedInstanceId]);

  const visibleModels = useMemo(() => {
    if (!legacySection) {
      return filteredModels;
    }
    return [
      ...legacySection.currentModels,
      ...(legacySection.isExpanded ? legacySection.legacyModels : []),
    ];
  }, [filteredModels, legacySection]);

  const allItemKeys = useAllItemKeys(input.flatModels);
  const filteredItemKeys = useMemo((): string[] => {
    const modelKeys = visibleModels.map((model) =>
      modelPickerModelKey(model.instanceId, model.slug),
    );
    if (!legacySection) {
      return modelKeys;
    }
    modelKeys.splice(legacySection.currentModels.length, 0, legacySection.key);
    return modelKeys;
  }, [legacySection, visibleModels]);
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(
        visibleModels.map(
          (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
        ),
      ),
    [visibleModels],
  );
  return {
    isSearching,
    legacySection,
    visibleModels,
    allItemKeys,
    filteredItemKeys,
    filteredModelByKey,
    toggleLegacySection,
  };
}
