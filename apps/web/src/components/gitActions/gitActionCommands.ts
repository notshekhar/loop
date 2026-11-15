import type { GitActionMenuItem, GitQuickAction } from "~/components/GitActionsControl.logic";
import { toastManager, type ThreadToastData } from "~/components/ui/toast";
import type { useVcsPullAction } from "~/lib/sourceControlActions";
import { runPullWithToast } from "./gitActionToasts";
import type { CommitDialogState } from "./useCommitDialogState";
import type { PendingDefaultBranchAction, RunGitActionWithToast } from "./useRunGitActionWithToast";

interface GitActionCommandDeps {
  readonly quickAction: GitQuickAction;
  readonly pendingDefaultBranchAction: PendingDefaultBranchAction | null;
  readonly setPendingDefaultBranchAction: (action: PendingDefaultBranchAction | null) => void;
  readonly commit: CommitDialogState;
  readonly runGitActionWithToast: RunGitActionWithToast;
  readonly openExistingPr: () => Promise<void>;
  readonly openPublishDialog: () => void;
  readonly pullAction: ReturnType<typeof useVcsPullAction>;
  readonly threadToastData: ThreadToastData | undefined;
}

function runQuickAction(deps: GitActionCommandDeps): void {
  const { quickAction, runGitActionWithToast } = deps;
  if (quickAction.kind === "open_pr") {
    void deps.openExistingPr();
    return;
  }
  if (quickAction.kind === "open_publish") {
    deps.openPublishDialog();
    return;
  }
  if (quickAction.kind === "run_pull") {
    runPullWithToast(deps.pullAction, deps.threadToastData);
    return;
  }
  if (quickAction.kind === "show_hint") {
    toastManager.add({
      type: "info",
      title: quickAction.label,
      description: quickAction.hint,
      data: deps.threadToastData,
    });
    return;
  }
  if (quickAction.action) {
    void runGitActionWithToast({ action: quickAction.action });
  }
}

function openDialogForMenuItem(deps: GitActionCommandDeps, item: GitActionMenuItem): void {
  const { runGitActionWithToast } = deps;
  if (item.disabled) return;
  if (item.kind === "open_pr") {
    void deps.openExistingPr();
    return;
  }
  if (item.dialogAction === "push") {
    void runGitActionWithToast({ action: "push" });
    return;
  }
  if (item.dialogAction === "create_pr") {
    void runGitActionWithToast({ action: "create_pr" });
    return;
  }
  deps.commit.openCommitDialog();
}

/** What each button, menu entry and dialog choice in the control does. */
export function createGitActionCommands(deps: GitActionCommandDeps) {
  const { commit, runGitActionWithToast } = deps;

  // Both answers to the default-branch prompt rerun the held action without asking again.
  const resumePendingAction = (featureBranch: boolean) => {
    if (!deps.pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = deps.pendingDefaultBranchAction;
    deps.setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      ...(featureBranch ? { featureBranch: true } : {}),
      skipDefaultBranchPrompt: true,
    });
  };

  const runCommitFromDialog = (onNewBranch: boolean) => {
    const request = commit.takeCommitRequest();
    if (!request) return;
    const { commitMessage, filePaths } = request;
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(filePaths ? { filePaths } : {}),
      ...(onNewBranch ? { featureBranch: true, skipDefaultBranchPrompt: true } : {}),
    });
  };

  return {
    runQuickAction: () => runQuickAction(deps),
    openDialogForMenuItem: (item: GitActionMenuItem) => openDialogForMenuItem(deps, item),
    continuePendingDefaultBranchAction: () => resumePendingAction(false),
    checkoutFeatureBranchAndContinuePendingAction: () => resumePendingAction(true),
    runDialogAction: () => runCommitFromDialog(false),
    runDialogActionOnNewBranch: () => runCommitFromDialog(true),
  };
}
