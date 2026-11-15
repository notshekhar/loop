import { scopeProjectRef, scopeThreadRef } from "@loop/runtime/environment";
import type { EnvironmentId, ThreadId } from "@loop/contracts";
import { useCallback, useEffect, useMemo } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useProject, useThread } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "../BranchToolbar.logic";

interface BranchThreadInput {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId: DraftId | undefined;
  effectiveEnvModeOverride: "local" | "worktree" | undefined;
  activeThreadBranchOverride: string | null | undefined;
  onActiveThreadBranchOverrideChange: ((refName: string | null) => void) | undefined;
}

export type BranchThread = ReturnType<typeof useBranchThread>;

/**
 * Thread / project state behind the branch selector (pushed down from the
 * parent to colocate with the branch mutation), plus that mutation.
 */
export function useBranchThread(input: BranchThreadInput) {
  const state = useBranchThreadState(input);
  const setThreadBranch = useSetThreadBranch(input, state);
  return { ...state, setThreadBranch };
}

function useBranchThreadState({
  environmentId,
  threadId,
  draftId,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
}: BranchThreadInput) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const serverSession = serverThread?.session ?? null;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);

  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch =
    activeThreadBranchOverride !== undefined
      ? activeThreadBranchOverride
      : (serverThread?.branch ?? draftThread?.branch ?? null);
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const branchCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== null;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread,
      draftThreadEnvMode: draftThread?.envMode,
    });
  return {
    threadRef,
    serverSession,
    setDraftThreadContext,
    activeProject,
    activeThreadId,
    activeThreadBranch,
    activeWorktreePath,
    activeProjectCwd,
    branchCwd,
    hasServerThread,
    effectiveEnvMode,
  };
}

// Colocated — only the branch selector calls it.
function useSetThreadBranch(
  { environmentId, draftId, onActiveThreadBranchOverrideChange }: BranchThreadInput,
  {
    threadRef,
    serverSession,
    setDraftThreadContext,
    activeProject,
    activeThreadId,
    activeWorktreePath,
    hasServerThread,
    effectiveEnvMode,
  }: ReturnType<typeof useBranchThreadState>,
) {
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  return useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId || !activeProject) return;
      if (serverSession && worktreePath !== activeWorktreePath) {
        void stopThreadSession({
          environmentId,
          input: { threadId: activeThreadId },
        });
      }
      if (hasServerThread) {
        void updateThreadMetadata({
          environmentId,
          input: {
            threadId: activeThreadId,
            branch,
            worktreePath,
          },
        });
      }
      if (hasServerThread) {
        onActiveThreadBranchOverrideChange?.(branch);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(draftId ?? threadRef, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
        projectRef: scopeProjectRef(environmentId, activeProject.id),
      });
    },
    [
      activeThreadId,
      activeProject,
      serverSession,
      activeWorktreePath,
      hasServerThread,
      onActiveThreadBranchOverrideChange,
      setDraftThreadContext,
      draftId,
      threadRef,
      environmentId,
      effectiveEnvMode,
      stopThreadSession,
      updateThreadMetadata,
    ],
  );
}

/** Seeds a worktree-mode thread that has no branch yet with the base candidate. */
export function useDefaultWorktreeBase(
  thread: BranchThread,
  worktreeBaseBranchCandidate: string | null,
) {
  const { activeThreadBranch, activeWorktreePath, effectiveEnvMode, setThreadBranch } = thread;
  useEffect(() => {
    if (
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !worktreeBaseBranchCandidate
    ) {
      return;
    }
    setThreadBranch(worktreeBaseBranchCandidate, null);
  }, [
    activeThreadBranch,
    activeWorktreePath,
    effectiveEnvMode,
    setThreadBranch,
    worktreeBaseBranchCandidate,
  ]);
}
