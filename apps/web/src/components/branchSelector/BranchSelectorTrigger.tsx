import type { VcsStatusResult } from "@loop/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";
import type { SourceControlPresentation } from "../../sourceControlPresentation";
import { resolveBranchToolbarPrBranch } from "../BranchToolbar.logic";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPr,
} from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { ComboboxTrigger } from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface BranchPrPillProps {
  gitStatus: VcsStatusResult | null;
  activeThreadBranch: string | null;
  resolvedActiveBranch: string | null;
  sourceControlPresentation: SourceControlPresentation;
}

// PR pill shown next to the branch selector when the active branch has one.
function BranchPrPill({
  gitStatus,
  activeThreadBranch,
  resolvedActiveBranch,
  sourceControlPresentation,
}: BranchPrPillProps) {
  const branchPr = resolveThreadPr({
    threadBranch: resolveBranchToolbarPrBranch({
      activeThreadBranch,
      resolvedActiveBranch,
    }),
    gitStatus,
  });
  const branchPrStatus = prStatusIndicator(branchPr, gitStatus?.sourceControlProvider);
  // Action-oriented tooltip (the pill opens the PR), distinct from the sidebar's
  // state-description tooltip.
  const branchPrTooltip = branchPr
    ? `Open ${sourceControlPresentation.terminology.singular} #${branchPr.number} (${branchPr.state}) in browser`
    : "";
  const openPrLink = useOpenPrLink();
  if (!branchPr || !branchPrStatus) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={branchPrTooltip}
            onClick={(event) => openPrLink(event, branchPrStatus.url)}
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-medium tabular-nums transition-colors hover:bg-muted/60",
              branchPrStatus.colorClass,
            )}
          />
        }
      >
        <ChangeRequestStatusIcon className="size-3" />
        <span>#{branchPr.number}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{branchPrTooltip}</TooltipPopup>
    </Tooltip>
  );
}

interface BranchSelectorTriggerProps extends BranchPrPillProps {
  className: string | undefined;
  triggerLabel: string;
  disabled: boolean;
  onBranchContextMenu: (event: ReactMouseEvent, branchName: string | null) => void;
}

/** The toolbar row: optional PR pill, then the combobox trigger. */
export function BranchSelectorTrigger({
  className,
  triggerLabel,
  disabled,
  onBranchContextMenu,
  ...prPill
}: BranchSelectorTriggerProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <BranchPrPill {...prPill} />
      {/* Context menu lives on the wrapper: the disabled Button has
          pointer-events-none, so the trigger itself never sees right-clicks
          while refs are loading or a branch action is pending. */}
      <span
        className="flex min-w-0"
        onContextMenu={(event) => onBranchContextMenu(event, prPill.resolvedActiveBranch)}
      >
        <ComboboxTrigger
          render={<Button variant="ghost" size="xs" />}
          className="min-w-0 max-w-full text-muted-foreground/70 hover:text-foreground/80"
          disabled={disabled}
        >
          <GitBranchIcon className="size-3 shrink-0 opacity-70" />
          <span className="min-w-0 max-w-[240px] truncate">{triggerLabel}</span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </ComboboxTrigger>
      </span>
    </div>
  );
}
