import type { VcsStatusResult } from "@loop/contracts";
import { useMemo } from "react";
import {
  buildMenuItems,
  type GitActionMenuItem,
  resolveQuickAction,
} from "~/components/GitActionsControl.logic";
import { getSourceControlPresentation } from "~/sourceControlPresentation";

type Terminology = ReturnType<typeof getSourceControlPresentation>["terminology"];

interface BranchFacts {
  readonly hasBranch: boolean;
  readonly hasChanges: boolean;
  readonly isAhead: boolean;
  readonly isBehind: boolean;
  readonly hasPushTarget: boolean;
}

function pushDisabledReason(facts: BranchFacts): string {
  if (!facts.hasBranch) {
    return "Detached HEAD: checkout a refName before pushing.";
  }
  if (facts.hasChanges) {
    return "Commit or stash local changes before pushing.";
  }
  if (facts.isBehind) {
    return "Branch is behind upstream. Pull/rebase before pushing.";
  }
  if (!facts.hasPushTarget) {
    return 'Add an "origin" remote before pushing.';
  }
  if (!facts.isAhead) {
    return "No local commits to push.";
  }
  return "Push is currently unavailable.";
}

function changeRequestDisabledReason(
  facts: BranchFacts & { readonly hasOpenPr: boolean },
  terminology: Terminology,
): string {
  if (facts.hasOpenPr) {
    return `View ${terminology.singular} is currently unavailable.`;
  }
  if (!facts.hasBranch) {
    return `Detached HEAD: checkout a refName before creating a ${terminology.singular}.`;
  }
  if (facts.hasChanges) {
    return `Commit local changes before creating a ${terminology.singular}.`;
  }
  if (!facts.hasPushTarget) {
    return `Add an "origin" remote before creating a ${terminology.singular}.`;
  }
  if (!facts.isAhead) {
    return `No local commits to include in a ${terminology.singular}.`;
  }
  if (facts.isBehind) {
    return `Branch is behind upstream. Pull/rebase before creating a ${terminology.singular}.`;
  }
  return `Create ${terminology.singular} is currently unavailable.`;
}

export function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasPrimaryRemote,
}: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const facts: BranchFacts = {
    hasBranch: gitStatus.refName !== null,
    hasChanges: gitStatus.hasWorkingTreeChanges,
    isAhead: gitStatus.aheadCount > 0,
    isBehind: gitStatus.behindCount > 0,
    hasPushTarget: gitStatus.hasUpstream || hasPrimaryRemote,
  };
  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;

  if (item.id === "commit") {
    if (!facts.hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }
  if (item.id === "push") {
    return pushDisabledReason(facts);
  }
  return changeRequestDisabledReason(
    { ...facts, hasOpenPr: gitStatus.pr?.state === "open" },
    terminology,
  );
}

/** The menu entries and the one-click quick action the current status allows. */
export function useGitActionAvailability(input: {
  gitStatusForActions: VcsStatusResult | null;
  isGitActionRunning: boolean;
  isDefaultRef: boolean;
  hasPrimaryRemote: boolean;
}) {
  const { gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote } = input;
  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isGitActionRunning],
  );
  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isDefaultRef, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  return { gitActionMenuItems, quickAction, quickActionDisabledReason };
}
