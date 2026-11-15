import type { ScopedThreadRef } from "@loop/contracts";
import { useMemo } from "react";
import { type DraftId } from "~/composerDraftStore";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsInitAction,
  useVcsPullAction,
} from "~/lib/sourceControlActions";
import { useGitActionAvailability } from "./gitActionAvailability";
import { useGitRepositoryStatus } from "./useGitRepositoryStatus";
import {
  useActiveThreadSources,
  useLiveThreadBranchSync,
  useThreadBranchSync,
} from "./useThreadBranchSync";

const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;

/**
 * What the control knows: the repo's status, the source-control actions bound to
 * this cwd, and the thread whose branch follows them.
 */
export function useGitActionsModel(input: {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId: DraftId | undefined;
}) {
  const { gitCwd, activeThreadRef, draftId } = input;
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const threadSources = useActiveThreadSources(activeThreadRef, draftId);
  const { persistThreadBranchSync, syncThreadBranchAfterGitAction } = useThreadBranchSync({
    activeThreadRef,
    draftId,
    ...threadSources,
  });
  const sourceControlScope = useMemo(
    () => ({ environmentId: activeEnvironmentId, cwd: gitCwd }),
    [activeEnvironmentId, gitCwd],
  );
  const status = useGitRepositoryStatus(activeEnvironmentId, gitCwd);
  const initAction = useVcsInitAction(sourceControlScope);
  const runImmediateGitAction = useGitStackedAction(sourceControlScope);
  const pullAction = useVcsPullAction(sourceControlScope);
  const isGitActionRunning = useSourceControlActionRunning(
    sourceControlScope,
    RUNNING_SOURCE_CONTROL_ACTIONS,
  );
  useLiveThreadBranchSync({
    ...threadSources,
    gitStatusForActions: status.gitStatus,
    isGitActionRunning,
    persistThreadBranchSync,
  });
  const availability = useGitActionAvailability({
    gitStatusForActions: status.gitStatus,
    isGitActionRunning,
    isDefaultRef: status.isDefaultRef,
    hasPrimaryRemote: status.hasPrimaryRemote,
  });
  return {
    activeEnvironmentId,
    threadToastData,
    syncThreadBranchAfterGitAction,
    status,
    initAction,
    runImmediateGitAction,
    pullAction,
    isGitActionRunning,
    ...availability,
  };
}
