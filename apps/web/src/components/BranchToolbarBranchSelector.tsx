import { useId } from "react";

import { BranchPickerPopup } from "./branchSelector/BranchPickerPopup";
import { BranchSelectorTrigger } from "./branchSelector/BranchSelectorTrigger";
import {
  type BranchToolbarBranchSelectorProps,
  useBranchSelector,
} from "./branchSelector/useBranchSelector";
import { Combobox } from "./ui/combobox";

export function BranchToolbarBranchSelector(props: BranchToolbarBranchSelectorProps) {
  const startFromOriginSwitchId = useId();
  const selector = useBranchSelector(props);
  const { thread, refs, active, pickerItems, scroll, isBranchMenuOpen } = selector;

  return (
    <Combobox
      items={pickerItems.branchPickerItems}
      filteredItems={pickerItems.filteredBranchPickerItems}
      autoHighlight
      virtualized
      onItemHighlighted={(_value, eventDetails) => {
        if (!isBranchMenuOpen || eventDetails.index < 0 || eventDetails.reason !== "keyboard") {
          return;
        }
        void scroll.branchListRef.current?.scrollIndexIntoView?.({
          index: eventDetails.index,
          animated: false,
        });
      }}
      onOpenChange={scroll.handleOpenChange}
      open={isBranchMenuOpen}
      value={active.resolvedActiveBranch}
    >
      <BranchSelectorTrigger
        className={props.className}
        gitStatus={refs.branchStatusQuery.data ?? null}
        activeThreadBranch={thread.activeThreadBranch}
        resolvedActiveBranch={active.resolvedActiveBranch}
        sourceControlPresentation={refs.sourceControlPresentation}
        triggerLabel={selector.triggerLabel}
        disabled={refs.isInitialBranchesLoadPending || selector.actions.isBranchActionPending}
        onBranchContextMenu={selector.handleBranchContextMenu}
      />
      <BranchPickerPopup
        branchQuery={selector.branchQuery}
        setBranchQuery={selector.setBranchQuery}
        list={{
          filteredItems: pickerItems.filteredBranchPickerItems,
          scroll,
          itemContext: selector.itemContext,
        }}
        startFromOriginToggle={
          selector.isSelectingWorktreeBase
            ? {
                switchId: startFromOriginSwitchId,
                startFromOrigin: props.startFromOrigin,
                onStartFromOriginChange: props.onStartFromOriginChange,
              }
            : null
        }
        branchStatusText={refs.branchStatusText}
      />
    </Combobox>
  );
}
