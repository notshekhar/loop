import type { VcsRef } from "@loop/contracts";
import { LegendList } from "@legendapp/list/react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { cn } from "../../lib/utils";
import type { SourceControlPresentation } from "../../sourceControlPresentation";
import { ComboboxItem, ComboboxListVirtualized } from "../ui/combobox";
import type { BranchListScroll } from "./useBranchListScroll";

export interface BranchPickerItemContext {
  checkoutPullRequestItemValue: string | null;
  createBranchItemValue: string | null;
  prReference: string | null;
  sourceControlPresentation: SourceControlPresentation;
  trimmedBranchQuery: string;
  branchByName: ReadonlyMap<string, VcsRef>;
  activeProjectCwd: string | null;
  onCheckoutPullRequest: () => void;
  createRef: (rawName: string) => void;
  selectBranch: (refName: VcsRef) => void;
  onBranchContextMenu: (event: ReactMouseEvent, branchName: string | null) => void;
}

function renderCheckoutPullRequestItem(
  context: BranchPickerItemContext,
  itemValue: string,
  index: number,
) {
  const SourceControlIcon = context.sourceControlPresentation.Icon;
  return (
    <ComboboxItem
      hideIndicator
      key={itemValue}
      index={index}
      value={itemValue}
      className="pe-2"
      onClick={context.onCheckoutPullRequest}
    >
      <div className="flex min-w-0 items-center gap-2 py-1">
        <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col items-start">
          <span className="truncate font-medium">
            Checkout {context.sourceControlPresentation.terminology.singular}
          </span>
          <span className="truncate text-muted-foreground text-xs">{context.prReference}</span>
        </span>
      </div>
    </ComboboxItem>
  );
}

function renderCreateBranchItem(
  context: BranchPickerItemContext,
  itemValue: string,
  index: number,
) {
  return (
    <ComboboxItem
      hideIndicator
      key={itemValue}
      index={index}
      value={itemValue}
      className="pe-1.5"
      onClick={() => context.createRef(context.trimmedBranchQuery)}
    >
      <span className="truncate">Create new ref &quot;{context.trimmedBranchQuery}&quot;</span>
    </ComboboxItem>
  );
}

function resolveRefBadge(refName: VcsRef, activeProjectCwd: string | null) {
  const hasSecondaryWorktree =
    refName.worktreePath && activeProjectCwd && refName.worktreePath !== activeProjectCwd;
  return refName.current
    ? "current"
    : hasSecondaryWorktree
      ? "worktree"
      : refName.isRemote
        ? "remote"
        : refName.isDefault
          ? "default"
          : null;
}

function renderRefItem(context: BranchPickerItemContext, itemValue: string, index: number) {
  const refName = context.branchByName.get(itemValue);
  if (!refName) return null;

  const badge = resolveRefBadge(refName, context.activeProjectCwd);
  return (
    <ComboboxItem
      hideIndicator
      key={itemValue}
      index={index}
      value={itemValue}
      className="pe-1.5"
      onClick={() => context.selectBranch(refName)}
      onContextMenu={(event) => context.onBranchContextMenu(event, itemValue)}
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate">{itemValue}</span>
        {badge && <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>}
      </div>
    </ComboboxItem>
  );
}

function renderPickerItem(context: BranchPickerItemContext, itemValue: string, index: number) {
  const { checkoutPullRequestItemValue, createBranchItemValue } = context;
  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return renderCheckoutPullRequestItem(context, itemValue, index);
  }
  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return renderCreateBranchItem(context, itemValue, index);
  }
  return renderRefItem(context, itemValue, index);
}

interface BranchPickerListProps {
  filteredItems: string[];
  scroll: BranchListScroll;
  itemContext: BranchPickerItemContext;
}

/** The virtualized ref list, with edge fades and paging driven by its scroll. */
export function BranchPickerList({ filteredItems, scroll, itemContext }: BranchPickerListProps) {
  const { checkoutPullRequestItemValue, createBranchItemValue } = itemContext;
  return (
    <div className="relative min-h-0 w-full max-h-56 flex-1 overflow-hidden">
      <ComboboxListVirtualized className="size-full min-w-0 p-0">
        <LegendList<string>
          ref={scroll.branchListRef}
          data={filteredItems}
          keyExtractor={(item) => item}
          getItemType={(item) =>
            item === checkoutPullRequestItemValue
              ? "checkout-pull-request"
              : item === createBranchItemValue
                ? "create-branch"
                : "branch"
          }
          renderItem={({ item, index }) => renderPickerItem(itemContext, item, index)}
          estimatedItemSize={28}
          drawDistance={336}
          onLayout={scroll.handleListLayout}
          onScroll={scroll.handleListScroll}
          className={cn(
            "scrollbar-gutter-stable overflow-x-hidden overscroll-y-contain ps-1 pe-0 pt-2 pb-1 [--fade-size:1.5rem]",
            scroll.showTopBranchScrollFade && "mask-t-from-[calc(100%-var(--fade-size))]",
            scroll.showBottomBranchScrollFade && "mask-b-from-[calc(100%-var(--fade-size))]",
          )}
          style={{ maxHeight: "14rem" }}
        />
      </ComboboxListVirtualized>
    </div>
  );
}
