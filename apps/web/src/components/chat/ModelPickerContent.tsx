import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@loop/contracts";
import { memo } from "react";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { ModelEsque } from "./providerIconUtils";
import { TooltipProvider } from "../ui/tooltip";
import { type ProviderInstanceEntry } from "../../providerInstances";
import { ModelPickerCombobox } from "./modelPicker/ModelPickerCombobox";
import { useModelPickerContent } from "./modelPicker/useModelPickerContent";

export interface ModelPickerContentProps {
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: ModelPickerContentProps) {
  const state = useModelPickerContent(props);
  const { selectedInstanceId, handleSelectInstance, showSidebar } = state;
  const { sidebarInstanceEntries, lockedDisabledInstanceIds } = state;
  return (
    <TooltipProvider delay={0}>
      <div
        className="dropdown-glass model-picker-surface relative flex h-screen max-h-86.5 w-screen max-w-90 flex-row overflow-hidden rounded-lg text-popover-foreground [clip-path:inset(0_round_var(--radius-lg))]"
        data-model-picker-content="true"
      >
        {/* Sidebar */}
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            instanceEntries={sidebarInstanceEntries}
            showFavorites
            {...(lockedDisabledInstanceIds
              ? {
                  disabledInstanceIds: lockedDisabledInstanceIds,
                  getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                    `${entry.displayName} is unavailable in this thread. Start a new thread to switch providers.`,
                }
              : {})}
          />
        )}

        {/* Main content area */}
        <ModelPickerCombobox
          state={state}
          activeInstanceId={props.activeInstanceId}
          model={props.model}
          onRequestClose={props.onRequestClose}
        />
      </div>
    </TooltipProvider>
  );
});
