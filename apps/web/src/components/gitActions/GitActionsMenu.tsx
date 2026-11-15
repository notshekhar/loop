import type { VcsStatusResult } from "@loop/contracts";
import { ChevronDownIcon, CloudUploadIcon } from "lucide-react";
import type { GitActionMenuItem } from "~/components/GitActionsControl.logic";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { getMenuActionDisabledReason } from "./gitActionAvailability";
import { GitActionItemIcon, type SourceControlIconComponent } from "./GitActionIcons";

export interface GitActionsMenuProps {
  readonly gitActionMenuItems: ReadonlyArray<GitActionMenuItem>;
  readonly gitStatusForActions: VcsStatusResult | null;
  readonly gitStatusError: string | null | undefined;
  readonly isGitActionRunning: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly canPublishRepository: boolean;
  readonly SourceControlIcon: SourceControlIconComponent;
  readonly onOpen: () => void;
  readonly onSelectItem: (item: GitActionMenuItem) => void;
  readonly onPublish: () => void;
}

export function GitActionsMenu(props: GitActionsMenuProps) {
  const { gitStatusForActions, isGitActionRunning } = props;
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) {
          props.onOpen();
        }
      }}
    >
      <MenuTrigger
        render={<Button aria-label="Git action options" size="icon-xs" variant="outline" />}
        disabled={isGitActionRunning}
      >
        <ChevronDownIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-full">
        {props.gitActionMenuItems.map((item) => (
          <GitActionMenuEntry key={`${item.id}-${item.label}`} item={item} {...props} />
        ))}
        {props.canPublishRepository ? (
          <MenuItem disabled={isGitActionRunning} onClick={props.onPublish}>
            <CloudUploadIcon />
            Publish repository...
          </MenuItem>
        ) : null}
        {gitStatusForActions?.refName === null && (
          <p className="px-2 py-1.5 text-xs text-warning">
            Detached HEAD: create and checkout a refName to enable push and pull request actions.
          </p>
        )}
        {gitStatusForActions &&
          gitStatusForActions.refName !== null &&
          !gitStatusForActions.hasWorkingTreeChanges &&
          gitStatusForActions.behindCount > 0 &&
          gitStatusForActions.aheadCount === 0 && (
            <p className="px-2 py-1.5 text-xs text-warning">Behind upstream. Pull/rebase first.</p>
          )}
        {props.gitStatusError && (
          <p className="px-2 py-1.5 text-xs text-destructive">{props.gitStatusError}</p>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** A disabled entry explains itself in a hover popover instead of just greying out. */
function GitActionMenuEntry({
  item,
  gitStatusForActions,
  isGitActionRunning,
  hasPrimaryRemote,
  SourceControlIcon,
  onSelectItem,
}: GitActionsMenuProps & { item: GitActionMenuItem }) {
  const disabledReason = getMenuActionDisabledReason({
    item,
    gitStatus: gitStatusForActions,
    isBusy: isGitActionRunning,
    hasPrimaryRemote,
  });
  if (item.disabled && disabledReason) {
    return (
      <Popover>
        <PopoverTrigger
          openOnHover
          nativeButton={false}
          render={<span className="block w-max cursor-not-allowed" />}
        >
          <MenuItem className="w-full" disabled>
            <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
            {item.label}
          </MenuItem>
        </PopoverTrigger>
        <PopoverPopup tooltipStyle side="left" align="center">
          {disabledReason}
        </PopoverPopup>
      </Popover>
    );
  }

  return (
    <MenuItem
      disabled={item.disabled}
      onClick={() => {
        onSelectItem(item);
      }}
    >
      <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
      {item.label}
    </MenuItem>
  );
}
