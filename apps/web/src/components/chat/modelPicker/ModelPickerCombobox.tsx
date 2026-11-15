import type { ProviderInstanceId } from "@loop/contracts";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "../modelPickerKeys";
import { Combobox, ComboboxEmpty } from "../../ui/combobox";
import { ModelPickerList } from "./ModelPickerList";
import { ModelPickerSearchInput } from "./ModelPickerSearchInput";
import type { ModelPickerContentState } from "./useModelPickerContent";

/** The search box and model list, driven as one inline combobox. */
export function ModelPickerCombobox(props: {
  state: ModelPickerContentState;
  activeInstanceId: ProviderInstanceId;
  model: string;
  onRequestClose: (() => void) | undefined;
}) {
  const {
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
    showSidebar,
  } = props.state;
  return (
    <Combobox
      inline
      items={list.allItemKeys}
      filteredItems={list.filteredItemKeys}
      filter={null}
      autoHighlight
      open
      virtualized
      value={modelPickerModelKey(props.activeInstanceId, props.model)}
      onItemHighlighted={(modelKey, eventDetails) => {
        highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
        if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
          void modelListRef.current?.scrollIndexIntoView?.({
            index: eventDetails.index,
            animated: false,
          });
        }
      }}
      onValueChange={(modelKey) => {
        if (typeof modelKey !== "string") {
          return;
        }
        activateItem(modelKey);
      }}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
          showSidebar && "border-l border-border/70",
        )}
      >
        <ModelPickerSearchInput
          searchInputRef={searchInputRef}
          highlightedModelKeyRef={highlightedModelKeyRef}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onRequestClose={props.onRequestClose}
          onActivateItem={activateItem}
        />
        <ModelPickerList
          modelListRef={modelListRef}
          filteredItemKeys={list.filteredItemKeys}
          filteredModelByKey={list.filteredModelByKey}
          legacySection={list.legacySection}
          favoritesSet={favoritesSet}
          activeInstanceId={props.activeInstanceId}
          model={props.model}
          isLocked={isLocked}
          modelJumpLabelByKey={modelJumpLabelByKey}
          getModelDisabledReason={getModelDisabledReason}
          onToggleFavorite={toggleFavorite}
          showTopScrollFade={scrollFades.showTopScrollFade}
          showBottomScrollFade={scrollFades.showBottomScrollFade}
          onScrollFadesChange={scrollFades.updateModelListScrollFades}
        />
        <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
          No models found
        </ComboboxEmpty>
      </div>
    </Combobox>
  );
}
