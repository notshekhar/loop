import type { EnvironmentId, ThreadId } from "@loop/contracts";
import { useState } from "react";

import type { DraftId } from "../../composerDraftStore";
import { resolveBranchTriggerLabel } from "../BranchToolbar.logic";
import type { BranchPickerItemContext } from "./BranchPickerList";
import { useBranchActions, useBranchContextMenu } from "./useBranchActions";
import { useBranchListScroll } from "./useBranchListScroll";
import { useBranchPickerItems } from "./useBranchPickerItems";
import { useActiveBranch, useBranchRefs } from "./useBranchRefs";
import { useBranchThread, useDefaultWorktreeBase } from "./useBranchThread";

export interface BranchToolbarBranchSelectorProps {
  className?: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  envLocked: boolean;
  effectiveEnvModeOverride?: "local" | "worktree";
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (refName: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

/** Everything the branch selector renders from: thread, refs, picker and list state. */
export function useBranchSelector(props: BranchToolbarBranchSelectorProps) {
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const data = useBranchSelectorData(props, branchQuery);
  const { thread, refs, active, pickerItems, isSelectingWorktreeBase } = data;
  const actions = useBranchActions({
    environmentId: props.environmentId,
    thread,
    refs,
    resolvedActiveBranch: active.resolvedActiveBranch,
    setOptimisticBranch: active.setOptimisticBranch,
    isSelectingWorktreeBase,
    setIsBranchMenuOpen,
    onComposerFocusRequest: props.onComposerFocusRequest,
  });
  const handleBranchContextMenu = useBranchContextMenu();
  useDefaultWorktreeBase(thread, refs.worktreeBaseBranchCandidate);
  const scroll = useBranchListScroll({
    isBranchMenuOpen,
    setIsBranchMenuOpen,
    setBranchQuery,
    loadNext: refs.branchRefState.loadNext,
    hasNextPage: refs.hasNextPage,
    isFetchingNextPage: refs.isFetchingNextPage,
    deferredTrimmedBranchQuery: refs.deferredTrimmedBranchQuery,
    filteredItemCount: pickerItems.filteredBranchPickerItems.length,
  });

  const handleCheckoutPullRequest = () => {
    const { prReference } = pickerItems;
    if (!prReference || !props.onCheckoutPullRequestRequest) {
      return;
    }
    setIsBranchMenuOpen(false);
    setBranchQuery("");
    props.onComposerFocusRequest?.();
    props.onCheckoutPullRequestRequest(prReference);
  };
  const itemContext = toItemContext(
    data,
    actions,
    handleBranchContextMenu,
    handleCheckoutPullRequest,
  );
  return {
    ...data,
    isBranchMenuOpen,
    branchQuery,
    setBranchQuery,
    actions,
    handleBranchContextMenu,
    scroll,
    itemContext,
  };
}

function toItemContext(
  { thread, refs, pickerItems }: ReturnType<typeof useBranchSelectorData>,
  actions: ReturnType<typeof useBranchActions>,
  onBranchContextMenu: BranchPickerItemContext["onBranchContextMenu"],
  onCheckoutPullRequest: () => void,
): BranchPickerItemContext {
  return {
    checkoutPullRequestItemValue: pickerItems.checkoutPullRequestItemValue,
    createBranchItemValue: pickerItems.createBranchItemValue,
    prReference: pickerItems.prReference,
    sourceControlPresentation: refs.sourceControlPresentation,
    trimmedBranchQuery: refs.trimmedBranchQuery,
    branchByName: refs.branchByName,
    activeProjectCwd: thread.activeProjectCwd,
    onCheckoutPullRequest,
    createRef: actions.createRef,
    selectBranch: actions.selectBranch,
    onBranchContextMenu,
  };
}

function useBranchSelectorData(props: BranchToolbarBranchSelectorProps, branchQuery: string) {
  const { environmentId } = props;
  const thread = useBranchThread({
    environmentId,
    threadId: props.threadId,
    draftId: props.draftId,
    effectiveEnvModeOverride: props.effectiveEnvModeOverride,
    activeThreadBranchOverride: props.activeThreadBranchOverride,
    onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange,
  });
  const refs = useBranchRefs({ environmentId, branchCwd: thread.branchCwd, branchQuery });
  const isSelectingWorktreeBase =
    thread.effectiveEnvMode === "worktree" && !props.envLocked && !thread.activeWorktreePath;
  const pickerItems = useBranchPickerItems({
    branchNames: refs.branchNames,
    hasExactBranchMatch: refs.branchByName.has(refs.trimmedBranchQuery),
    trimmedBranchQuery: refs.trimmedBranchQuery,
    deferredTrimmedBranchQuery: refs.deferredTrimmedBranchQuery,
    isSelectingWorktreeBase,
    canCheckoutPullRequest: Boolean(props.onCheckoutPullRequestRequest),
  });
  const active = useActiveBranch({
    environmentId,
    branchCwd: thread.branchCwd,
    effectiveEnvMode: thread.effectiveEnvMode,
    activeWorktreePath: thread.activeWorktreePath,
    activeThreadBranch: thread.activeThreadBranch,
    currentGitBranch: refs.currentGitBranch,
    branchByName: refs.branchByName,
  });
  const triggerLabel = resolveBranchTriggerLabel({
    activeWorktreePath: thread.activeWorktreePath,
    effectiveEnvMode: thread.effectiveEnvMode,
    resolvedActiveBranch: active.resolvedActiveBranch,
    resolvedActiveBranchIsRemote: active.resolvedActiveBranchIsRemote,
    startFromOrigin: props.startFromOrigin,
  });
  return { thread, refs, isSelectingWorktreeBase, pickerItems, active, triggerLabel };
}
