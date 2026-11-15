import type { ProviderInstanceId } from "@loop/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { RefObject } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ModelListRow } from "../ModelListRow";
import { modelPickerModelKey } from "../modelPickerKeys";
import { isModelPickerNewModel } from "../modelPickerModelHighlights";
import { ComboboxItem, ComboboxListVirtualized } from "../../ui/combobox";
import { cn } from "~/lib/utils";
import { providerModelKey } from "../../../modelOrdering";
import type { ModelPickerItem, ModelPickerLegacySection } from "./modelPickerItems";

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

// Rendered inline rather than as a component so a recycled list slot holds the
// ComboboxItem directly.
function renderLegacyModelsRow(
  modelKey: string,
  index: number,
  legacySection: ModelPickerLegacySection,
) {
  return (
    <ComboboxItem
      hideIndicator
      index={index}
      value={modelKey}
      aria-expanded={legacySection.isExpanded}
      className="group w-full cursor-pointer rounded-md px-2 py-2"
      contentClassName="flex w-full items-center gap-3"
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="text-xs font-medium leading-snug">Legacy models</div>
        <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
          {legacySection.legacyModels.length} models
        </div>
      </div>
      <ChevronRightIcon
        className={cn("size-4 transition-transform", legacySection.isExpanded && "rotate-90")}
      />
    </ComboboxItem>
  );
}

export function ModelPickerList(props: {
  modelListRef: RefObject<LegendListRef | null>;
  filteredItemKeys: string[];
  filteredModelByKey: ReadonlyMap<string, ModelPickerItem>;
  legacySection: ModelPickerLegacySection | null;
  favoritesSet: ReadonlySet<string>;
  activeInstanceId: ProviderInstanceId;
  model: string;
  isLocked: boolean;
  modelJumpLabelByKey: ReadonlyMap<string, string>;
  getModelDisabledReason:
    | ((instanceId: ProviderInstanceId, model: string) => string | null)
    | undefined;
  onToggleFavorite: (instanceId: ProviderInstanceId, model: string) => void;
  showTopScrollFade: boolean;
  showBottomScrollFade: boolean;
  onScrollFadesChange: () => void;
}) {
  const { legacySection, favoritesSet, filteredModelByKey, getModelDisabledReason } = props;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden pr-px">
      <ComboboxListVirtualized className="size-full min-w-0 p-0 not-empty:p-0">
        <LegendList<string>
          ref={props.modelListRef}
          data={props.filteredItemKeys}
          extraData={favoritesSet}
          keyExtractor={(modelKey) => modelKey}
          renderItem={({ item: modelKey, index }) => {
            if (legacySection?.key === modelKey) {
              return renderLegacyModelsRow(modelKey, index, legacySection);
            }
            const model = filteredModelByKey.get(modelKey);
            if (!model) {
              return null;
            }
            const disabledReason = getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
            return (
              <ModelListRow
                key={modelKey}
                index={index}
                model={model}
                instanceId={model.instanceId}
                driverKind={model.driverKind}
                providerDisplayName={model.instanceDisplayName}
                providerAccentColor={model.instanceAccentColor}
                isFavorite={favoritesSet.has(providerModelKey(model.instanceId, model.slug))}
                isSelected={modelKey === modelPickerModelKey(props.activeInstanceId, props.model)}
                showProvider
                preferShortName={!props.isLocked}
                useTriggerLabel={false}
                showNewBadge={isModelPickerNewModel(model.driverKind, model.slug)}
                jumpLabel={props.modelJumpLabelByKey.get(modelKey) ?? null}
                disabledReason={disabledReason}
                onToggleFavorite={() => props.onToggleFavorite(model.instanceId, model.slug)}
              />
            );
          }}
          estimatedItemSize={52}
          drawDistance={480}
          recycleItems
          contentContainerClassName="pl-2 pr-px"
          ItemSeparatorComponent={ModelListSeparator}
          onLayout={props.onScrollFadesChange}
          onScroll={props.onScrollFadesChange}
          className={cn(
            "model-picker-list h-full overflow-x-hidden overscroll-y-contain py-1.5 [--fade-size:1.5rem]",
            props.showTopScrollFade && "model-picker-list-scroll-fade-top",
            props.showBottomScrollFade && "model-picker-list-scroll-fade-bottom",
          )}
        />
      </ComboboxListVirtualized>
    </div>
  );
}
