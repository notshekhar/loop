import { type ScopedThreadRef } from "@loop/contracts";
import { useState } from "react";
import { resolveDefaultBranchActionDialogCopy } from "./GitActionsControl.logic";
import { type DraftId } from "~/composerDraftStore";
import { CommitDialog } from "./gitActions/CommitDialog";
import { DefaultBranchActionDialog } from "./gitActions/DefaultBranchActionDialog";
import { createGitActionCommands } from "./gitActions/gitActionCommands";
import { runInitWithToast } from "./gitActions/gitActionToasts";
import { GitActionsGroup, InitializeGitButton } from "./gitActions/GitActionsToolbar";
import { PublishRepositoryDialog } from "./gitActions/PublishRepositoryDialog";
import { useCommitDialogState } from "./gitActions/useCommitDialogState";
import { useGitActionLinks } from "./gitActions/useGitActionLinks";
import { useGitActionProgressToast } from "./gitActions/useGitActionProgressToast";
import { useGitActionsModel } from "./gitActions/useGitActionsModel";
import {
  requestVcsStatusRefresh,
  useGitStatusRefreshOnFocus,
} from "./gitActions/useGitRepositoryStatus";
import {
  type PendingDefaultBranchAction,
  useRunGitActionWithToast,
} from "./gitActions/useRunGitActionWithToast";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
}

export default function GitActionsControl({
  gitCwd,
  activeThreadRef,
  draftId,
}: GitActionsControlProps) {
  const model = useGitActionsModel({ gitCwd, activeThreadRef, draftId });
  const { activeEnvironmentId, threadToastData, status, isGitActionRunning } = model;
  const { isRepo, hasPrimaryRemote, isDefaultRef, SourceControlIcon } = status;
  const gitStatusForActions = status.gitStatus;
  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const commit = useCommitDialogState(allFiles);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);

  const { activeGitActionProgressRef, updateActiveProgressToast } = useGitActionProgressToast();
  useGitStatusRefreshOnFocus(status.refreshVcsStatus, activeEnvironmentId, gitCwd);
  const { openExistingPr, openChangedFileInEditor } = useGitActionLinks({
    activeEnvironmentId,
    gitCwd,
    gitStatusForActions,
    threadToastData,
  });
  const runGitActionWithToast = useRunGitActionWithToast({
    gitCwd,
    gitStatusForActions,
    isDefaultRef,
    changeRequestTerminology: status.changeRequestTerminology,
    threadToastData,
    activeGitActionProgressRef,
    updateActiveProgressToast,
    runImmediateGitAction: model.runImmediateGitAction,
    syncThreadBranchAfterGitAction: model.syncThreadBranchAfterGitAction,
    setPendingDefaultBranchAction,
  });
  const commands = createGitActionCommands({
    quickAction: model.quickAction,
    pendingDefaultBranchAction,
    setPendingDefaultBranchAction,
    commit,
    runGitActionWithToast,
    openExistingPr,
    openPublishDialog: () => setIsPublishDialogOpen(true),
    pullAction: model.pullAction,
    threadToastData,
  });
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
        terminology: status.changeRequestTerminology,
      })
    : null;

  const canPublishRepository = isRepo && gitStatusForActions !== null && !hasPrimaryRemote;

  if (!gitCwd) return null;

  return (
    <>
      {!isRepo ? (
        <InitializeGitButton
          isPending={model.initAction.isPending}
          onInitialize={() => runInitWithToast(model.initAction, threadToastData)}
        />
      ) : (
        <GitActionsGroup
          quickActionProps={{
            quickAction: model.quickAction,
            quickActionDisabledReason: model.quickActionDisabledReason,
            isGitActionRunning,
            SourceControlIcon,
            onRun: commands.runQuickAction,
          }}
          menuProps={{
            gitActionMenuItems: model.gitActionMenuItems,
            gitStatusForActions,
            gitStatusError: status.gitStatusError,
            isGitActionRunning,
            hasPrimaryRemote,
            canPublishRepository,
            SourceControlIcon,
            onOpen: () => {
              requestVcsStatusRefresh(status.refreshVcsStatus, activeEnvironmentId, gitCwd);
            },
            onSelectItem: commands.openDialogForMenuItem,
            onPublish: () => {
              setIsPublishDialogOpen(true);
            },
          }}
        />
      )}

      <CommitDialog
        commit={commit}
        allFiles={allFiles}
        hasStatus={!!gitStatusForActions}
        branchName={gitStatusForActions?.refName}
        isDefaultRef={isDefaultRef}
        onOpenFile={openChangedFileInEditor}
        onCommit={commands.runDialogAction}
        onCommitOnNewBranch={commands.runDialogActionOnNewBranch}
      />

      <PublishRepositoryDialog
        open={isPublishDialogOpen}
        onOpenChange={setIsPublishDialogOpen}
        environmentId={activeEnvironmentId}
        gitCwd={gitCwd}
      />

      <DefaultBranchActionDialog
        open={pendingDefaultBranchAction !== null}
        copy={pendingDefaultBranchActionCopy}
        onAbort={() => setPendingDefaultBranchAction(null)}
        onContinue={commands.continuePendingDefaultBranchAction}
        onCheckoutFeatureBranch={commands.checkoutFeatureBranchAndContinuePendingAction}
      />
    </>
  );
}
