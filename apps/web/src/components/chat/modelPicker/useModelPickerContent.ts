import type { ResolvedKeybindingsConfig } from "@loop/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useMemo, useRef, useState } from "react";
import { useClientSettings } from "~/hooks/useSettings";
import type { ModelPickerContentProps } from "../ModelPickerContent";
import { useModelListScrollFades } from "./useModelListScrollFades";
import { useModelPickerActions } from "./useModelPickerActions";
import { useModelPickerCatalog } from "./useModelPickerCatalog";
import { useModelPickerJumpShortcuts } from "./useModelPickerJumpShortcuts";
import { useModelPickerList } from "./useModelPickerList";
import { useModelPickerSelection } from "./useModelPickerSelection";

/** All of the picker's state and handlers, wired together in dependency order. */
export function useModelPickerContent(props: ModelPickerContentProps) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useClientSettings((s) => s.favorites ?? []);
  const { selectedInstanceId, handleSelectInstance } = useModelPickerSelection({
    searchInputRef,
    lockedProvider: props.lockedProvider,
    activeInstanceId: props.activeInstanceId,
    hasFavorites: favorites.length > 0,
  });
  const keybindings = useMemo<ResolvedKeybindingsConfig>(
    () => providedKeybindings ?? [],
    [providedKeybindings],
  );
  const catalog = useModelPickerCatalog({
    favorites,
    instanceEntries,
    modelOptionsByInstance,
    lockedProvider: props.lockedProvider,
    lockedContinuationGroupKey: props.lockedContinuationGroupKey,
  });
  const { favoritesSet, lockedDisabledInstanceIds, sidebarInstanceEntries } = catalog;
  const list = useModelPickerList({
    flatModels: catalog.flatModels,
    searchQuery,
    selectedInstanceId,
    favoritesSet,
    instanceOrder: catalog.instanceOrder,
    lockedProvider: props.lockedProvider,
    matchesLockedProvider: catalog.matchesLockedProvider,
    activeInstanceId: props.activeInstanceId,
    model: props.model,
    modelOptionsByInstance,
  });
  const isLocked = props.lockedProvider !== null;
  const showSidebar = !list.isSearching && sidebarInstanceEntries.length > 0;
  const { handleModelSelect, toggleFavorite, activateItem } = useModelPickerActions({
    favorites,
    modelOptionsByInstance,
    entryByInstanceId: catalog.entryByInstanceId,
    getModelDisabledReason,
    onInstanceModelChange,
    toggleLegacySection: list.toggleLegacySection,
  });
  const modelJumpLabelByKey = useModelPickerJumpShortcuts({
    visibleModels: list.visibleModels,
    keybindings,
    terminalOpen: props.terminalOpen,
    getModelDisabledReason,
    onSelectModel: handleModelSelect,
  });
  const scrollFades = useModelListScrollFades(modelListRef, list.filteredItemKeys);

  return {
    selectedInstanceId,
    handleSelectInstance,
    showSidebar,
    sidebarInstanceEntries,
    lockedDisabledInstanceIds,
    list,
    highlightedModelKeyRef,
    modelListRef,
    searchInputRef,
    searchQuery,
    setSearchQuery,
    favoritesSet,
    isLocked,
    modelJumpLabelByKey,
    toggleFavorite,
    activateItem,
    scrollFades,
    getModelDisabledReason,
  };
}


export type ModelPickerContentState = ReturnType<typeof useModelPickerContent>;
