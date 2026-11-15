import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import type { ContextMenuItem, EnvironmentId, VcsRef } from "@loop/contracts";
import { useCallback, useTransition, type MouseEvent as ReactMouseEvent } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import {
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
} from "../BranchToolbar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { BranchRefs } from "./useBranchRefs";
import type { BranchThread } from "./useBranchThread";

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function toastBranchActionFailure<A, E>(
  title: string,
  result: Exclude<AtomCommandResult<A, E>, { readonly _tag: "Success" }>,
) {
  if (isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: toBranchActionErrorMessage(squashAtomCommandFailure(result)),
    }),
  );
}

function useBranchCommands() {
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, {
    reportFailure: false,
  });
  const createRefMutation = useAtomCommand(vcsEnvironment.createRef, {
    reportFailure: false,
  });
  return { switchRef, createRefMutation };
}

interface BranchActionsInput {
  environmentId: EnvironmentId;
  thread: BranchThread;
  refs: BranchRefs;
  resolvedActiveBranch: string | null;
  setOptimisticBranch: (branch: string | null) => void;
  isSelectingWorktreeBase: boolean;
  setIsBranchMenuOpen: (open: boolean) => void;
  onComposerFocusRequest: (() => void) | undefined;
}

type BranchActionContext = Omit<BranchActionsInput, "refs" | "onComposerFocusRequest"> &
  ReturnType<typeof useBranchCommands> & {
    isBranchActionPending: boolean;
    closeMenuAndFocusComposer: () => void;
    runBranchAction: (action: () => Promise<void>) => void;
  };

/** Switching to and creating refs, each refreshing the ref list when it settles. */
export function useBranchActions(input: BranchActionsInput) {
  const { refs, setIsBranchMenuOpen, onComposerFocusRequest } = input;
  const commands = useBranchCommands();
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const context: BranchActionContext = {
    ...input,
    ...commands,
    isBranchActionPending,
    closeMenuAndFocusComposer: () => {
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
    },
    runBranchAction: (action) => {
      startBranchActionTransition(async () => {
        await action();
        refs.branchRefState.refresh();
        refs.branchStatusQuery.refresh();
      });
    },
  };
  return {
    isBranchActionPending,
    selectBranch: (refName: VcsRef) => selectBranch(context, refName),
    createRef: (rawName: string) => createRef(context, rawName),
  };
}

function selectBranch(context: BranchActionContext, refName: VcsRef) {
  const { thread, isBranchActionPending, isSelectingWorktreeBase } = context;
  const { branchCwd, activeProjectCwd, activeWorktreePath, setThreadBranch } = thread;
  if (!branchCwd || !activeProjectCwd || isBranchActionPending) return;

  if (isSelectingWorktreeBase) {
    setThreadBranch(refName.name, null);
    context.closeMenuAndFocusComposer();
    return;
  }

  const selectionTarget = resolveBranchSelectionTarget({
    activeProjectCwd,
    activeWorktreePath,
    refName,
  });

  if (selectionTarget.reuseExistingWorktree) {
    setThreadBranch(refName.name, selectionTarget.nextWorktreePath);
    context.closeMenuAndFocusComposer();
    return;
  }

  context.closeMenuAndFocusComposer();
  checkoutRef(context, refName, selectionTarget);
}

function checkoutRef(
  context: BranchActionContext,
  refName: VcsRef,
  selectionTarget: { checkoutCwd: string; nextWorktreePath: string | null },
) {
  const { environmentId, resolvedActiveBranch, setOptimisticBranch, switchRef } = context;
  const selectedBranchName = refName.isRemote
    ? deriveLocalBranchNameFromRemoteRef(refName.name)
    : refName.name;

  context.runBranchAction(async () => {
    const previousBranch = resolvedActiveBranch;
    setOptimisticBranch(selectedBranchName);
    const checkoutResult = await switchRef({
      environmentId,
      input: {
        cwd: selectionTarget.checkoutCwd,
        refName: refName.name,
      },
    });
    if (checkoutResult._tag === "Success") {
      const nextBranchName = refName.isRemote
        ? (checkoutResult.value.refName ?? selectedBranchName)
        : selectedBranchName;
      setOptimisticBranch(nextBranchName);
      context.thread.setThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
      return;
    }
    setOptimisticBranch(previousBranch);
    toastBranchActionFailure("Failed to switch ref.", checkoutResult);
  });
}

function createRef(context: BranchActionContext, rawName: string) {
  const { environmentId, thread, resolvedActiveBranch, setOptimisticBranch } = context;
  const name = rawName.trim();
  if (!thread.branchCwd || !name || context.isBranchActionPending) return;
  const branchCwd = thread.branchCwd;

  context.closeMenuAndFocusComposer();

  context.runBranchAction(async () => {
    const previousBranch = resolvedActiveBranch;
    setOptimisticBranch(name);
    const createBranchResult = await context.createRefMutation({
      environmentId,
      input: {
        cwd: branchCwd,
        refName: name,
        switchRef: true,
      },
    });
    if (createBranchResult._tag === "Success") {
      setOptimisticBranch(createBranchResult.value.refName);
      thread.setThreadBranch(createBranchResult.value.refName, thread.activeWorktreePath);
      return;
    }
    setOptimisticBranch(previousBranch);
    toastBranchActionFailure("Failed to create and switch ref.", createBranchResult);
  });
}

/** Right-click "Copy branch name" on the trigger and on each listed ref. */
export function useBranchContextMenu() {
  const copyBranchName = useCallback((branchName: string) => {
    void writeTextToClipboard(branchName, "branch name").then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: "Branch name copied",
          description: branchName,
        });
      },
      (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy branch name",
            description: toBranchActionErrorMessage(error),
          }),
        );
      },
    );
  }, []);

  return useCallback(
    (event: ReactMouseEvent, branchName: string | null) => {
      if (!branchName) return;
      const api = readLocalApi();
      if (!api) return;
      event.preventDefault();
      event.stopPropagation();
      const items: ContextMenuItem<"copy-branch-name">[] = [
        { id: "copy-branch-name", label: "Copy branch name", icon: "copy" },
      ];
      void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((action) => {
        if (action === "copy-branch-name") copyBranchName(branchName);
      });
    },
    [copyBranchName],
  );
}
