import { GitBranchPlusIcon } from "lucide-react";
import type { GitQuickAction } from "~/components/GitActionsControl.logic";
import { Button } from "~/components/ui/button";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { GitQuickActionIcon, type SourceControlIconComponent } from "./GitActionIcons";
import { GitActionsMenu, type GitActionsMenuProps } from "./GitActionsMenu";

export function InitializeGitButton({
  isPending,
  onInitialize,
}: {
  isPending: boolean;
  onInitialize: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={isPending}
      onClick={() => {
        onInitialize();
      }}
    >
      <GitBranchPlusIcon className="size-3.5" aria-hidden />
      <span className="ml-0.5">{isPending ? "Initializing..." : "Initialize Git"}</span>
    </Button>
  );
}

interface GitQuickActionButtonProps {
  readonly quickAction: GitQuickAction;
  readonly quickActionDisabledReason: string | null;
  readonly isGitActionRunning: boolean;
  readonly SourceControlIcon: SourceControlIconComponent;
  readonly onRun: () => void;
}

/** A disabled quick action stays hoverable so its popover can say why. */
function GitQuickActionButton({
  quickAction,
  quickActionDisabledReason,
  isGitActionRunning,
  SourceControlIcon,
  onRun,
}: GitQuickActionButtonProps) {
  if (quickActionDisabledReason) {
    return (
      <Popover>
        <PopoverTrigger
          openOnHover
          render={
            <Button
              aria-disabled="true"
              className="cursor-not-allowed rounded-e-none border-e-0 ps-[8.5px] opacity-64 before:rounded-e-none"
              size="xs"
              variant="outline"
            />
          }
        >
          <GitQuickActionIcon quickAction={quickAction} SourceControlIcon={SourceControlIcon} />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            {quickAction.label}
          </span>
        </PopoverTrigger>
        <PopoverPopup tooltipStyle side="bottom" align="start">
          {quickActionDisabledReason}
        </PopoverPopup>
      </Popover>
    );
  }
  return (
    <Button
      variant="outline"
      size="xs"
      className="ps-[8.5px]"
      disabled={isGitActionRunning || quickAction.disabled}
      onClick={onRun}
    >
      <GitQuickActionIcon quickAction={quickAction} SourceControlIcon={SourceControlIcon} />
      <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
        {quickAction.label}
      </span>
    </Button>
  );
}

export function GitActionsGroup({
  quickActionProps,
  menuProps,
}: {
  quickActionProps: GitQuickActionButtonProps;
  menuProps: GitActionsMenuProps;
}) {
  return (
    <Group aria-label="Git actions" className="shrink-0">
      <GitQuickActionButton {...quickActionProps} />
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <GitActionsMenu {...menuProps} />
    </Group>
  );
}
