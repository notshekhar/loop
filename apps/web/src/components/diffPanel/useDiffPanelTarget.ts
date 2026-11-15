import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@loop/contracts";
import { scopeThreadRef } from "@loop/runtime/environment";
import { useCallback } from "react";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  type DiffPanelSelection,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "../../diffPanelStore";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useRightPanelStore } from "../../rightPanelStore";
import { useProject, useThread } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { vcsEnvironment } from "../../state/vcs";
import { resolveThreadRouteRef } from "../../threadRoutes";

/** The thread (or draft) the panel belongs to, and the folder it reads. */
export function useDiffPanelThread(composerDraftTarget: ScopedThreadRef | DraftId) {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThread(routeThreadRef);
  /**
   * A thread that has not been sent yet still belongs to a folder.
   *
   * Turn diffs need a server thread — there are no turns before one exists —
   * but the working tree does not: it only needs a cwd. Reading that from the
   * draft (the same fallback the terminal drawer uses) is what lets the panel
   * open on a brand new thread, where it used to say "select a thread" over a
   * folder full of uncommitted changes.
   */
  const draftThread = useComposerDraftStore((store) =>
    // A draft route has no thread ref at all — the draft is keyed by its own
    // id, which is exactly what `composerDraftTarget` carries. Looking it up
    // by ref found nothing, so the panel opened onto "select a thread".
    typeof composerDraftTarget === "string"
      ? store.getDraftSession(composerDraftTarget)
      : store.getDraftSessionByRef(composerDraftTarget),
  );
  const diffEnvironmentId = activeThread?.environmentId ?? draftThread?.environmentId ?? null;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useProject(
    diffEnvironmentId && activeProjectId
      ? {
          environmentId: diffEnvironmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const projectCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  /**
   * What the scope and base-ref pickers write against.
   *
   * A draft route has no thread ref, and every picker here bailed on that —
   * the panel was stuck on whatever scope it opened with, which in a folder of
   * repositories meant "branch changes" and so only the one repo that had
   * commits ahead. The draft carries the same pre-allocated thread id the
   * server thread will get, so a selection made now survives the promotion.
   */
  const diffSelectionRef =
    routeThreadRef ??
    (draftThread ? scopeThreadRef(draftThread.environmentId, draftThread.threadId) : null);
  return {
    routeThreadRef,
    activeThreadId,
    activeThread,
    diffEnvironmentId,
    projectCwd,
    diffSelectionRef,
  };
}

/** The open repository's path inside the project, when the project is a folder of them. */
export function resolveDiffPanelCwd(
  projectCwd: string | undefined,
  openRepository: string | null,
): string | undefined {
  return projectCwd && openRepository
    ? `${projectCwd.replace(/\/$/, "")}/${openRepository}`
    : projectCwd;
}

/** Server config, editor launcher and git status for the folder on screen. */
export function useDiffPanelEnvironment(
  diffEnvironmentId: ReturnType<typeof useDiffPanelThread>["diffEnvironmentId"],
  activeCwd: string | undefined,
) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(diffEnvironmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    diffEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const gitStatusQuery = useEnvironmentQuery(
    diffEnvironmentId !== null && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: diffEnvironmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  return { serverConfig, openInPreferredEditor, gitStatusQuery };
}

/** The stored scope/turn selection, and how a nested repository is opened. */
export function useDiffPanelSelection(
  diffSelectionRef: ScopedThreadRef | null,
  initialGitScope: "branch" | "unstaged",
  setOpenRepository: (repository: string | null) => void,
) {
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(
      state.byThreadKey,
      diffSelectionRef,
      initialGitScope === "unstaged",
    ),
  );
  const openRepositoryDiffTab = useRightPanelStore((state) => state.openRepositoryDiff);
  /**
   * Opening a repository opens a tab, not an in-place drill.
   *
   * Drilling meant this surface could show one repository at a time and going
   * back lost the place; a tab behaves like everything else the panel opens.
   */
  const openRepositoryInTab = useCallback(
    (repository: string) => {
      if (diffSelectionRef === null) {
        setOpenRepository(repository);
        return;
      }
      openRepositoryDiffTab(diffSelectionRef, repository);
    },
    [diffSelectionRef, openRepositoryDiffTab],
  );
  return { diffSelection, openRepositoryInTab };
}

/** The parts of a stored selection the panel reads. */
export function describeDiffSelection(diffSelection: DiffPanelSelection) {
  return {
    selectedTurnId: diffSelection.kind === "turn" ? diffSelection.turnId : null,
    selectedBaseRef: diffSelection.kind === "branch" ? diffSelection.baseRef : null,
    selectedFilePath: diffSelection.kind === "turn" ? diffSelection.filePath : null,
    selectedFileRevealRequestId:
      diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0,
  };
}
