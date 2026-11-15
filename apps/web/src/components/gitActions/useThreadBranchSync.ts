import type { GitRunStackedActionResult, ScopedThreadRef, VcsStatusResult } from "@loop/contracts";
import { useCallback, useEffect } from "react";
import {
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  resolveThreadBranchUpdate,
} from "~/components/GitActionsControl.logic";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useThread } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/** The thread this control belongs to: a server thread, or a draft that has none yet. */
export function useActiveThreadSources(
  activeThreadRef: ScopedThreadRef | null,
  draftId: DraftId | undefined,
) {
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const activeServerThread = useThread(activeThreadRef, {
    waitForShell: activeDraftThread !== null,
  });
  return { activeDraftThread, activeServerThread };
}

type ActiveThreadSources = ReturnType<typeof useActiveThreadSources>;

interface ThreadBranchSyncInput extends ActiveThreadSources {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly draftId: DraftId | undefined;
}

/** Writes the branch git ended up on back to the thread (server metadata or draft context). */
export function useThreadBranchSync({
  activeThreadRef,
  draftId,
  activeDraftThread,
  activeServerThread,
}: ThreadBranchSyncInput) {
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread branch metadata update",
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        void updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            ...resolveThreadBranchMetadataPatch(branch, activeServerThread.branch),
          },
        });

        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
      });
    },
    [
      activeDraftThread,
      activeServerThread,
      activeThreadRef,
      draftId,
      setDraftThreadContext,
      updateThreadMetadata,
    ],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch);
    },
    [persistThreadBranchSync],
  );

  return { persistThreadBranchSync, syncThreadBranchAfterGitAction };
}

interface LiveThreadBranchSyncInput extends ActiveThreadSources {
  readonly gitStatusForActions: VcsStatusResult | null;
  readonly isGitActionRunning: boolean;
  readonly persistThreadBranchSync: (branch: string | null) => void;
}

/** Keeps a draft thread's branch following the repo while no git action is moving it. */
export function useLiveThreadBranchSync({
  activeDraftThread,
  activeServerThread,
  gitStatusForActions,
  isGitActionRunning,
  persistThreadBranchSync,
}: LiveThreadBranchSyncInput) {
  const isSelectingWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  useEffect(() => {
    if (isGitActionRunning || isSelectingWorktreeBase || activeServerThread) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeDraftThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread,
    activeDraftThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    isSelectingWorktreeBase,
    persistThreadBranchSync,
  ]);
}
