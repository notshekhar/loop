import type { ScopedThreadRef } from "@loop/contracts";
import type { RefObject } from "react";
import type { DraftId } from "../../composerDraftStore";
import type { AnnotatableCodeViewHandle } from "../diffs/AnnotatableCodeView";
import type { DiffFilesViewProps } from "./DiffFilesView";
import { useCollapsedDiffFiles, useDiffFileCollapseActions } from "./useCollapsedDiffFiles";
import { useDiffAutoRefresh } from "./useDiffAutoRefresh";
import { useDiffFiles, useRevealSelectedFile } from "./useDiffFiles";
import {
  describeDiffSelection,
  resolveDiffPanelCwd,
  useDiffPanelEnvironment,
  useDiffPanelSelection,
  useDiffPanelThread,
} from "./useDiffPanelTarget";
import { describeReviewSection, useDiffPanelTurns } from "./useDiffPanelTurns";
import type { DiffViewOptions } from "./useDiffViewOptions";
import { useOpenDiffFile } from "./useOpenDiffFile";
import { useScmStatusOverride } from "./useScmStatusOverride";
import { useSelectedDiffPatch } from "./useSelectedDiffPatch";

interface DiffPanelSourceInput {
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly initialGitScope: "branch" | "unstaged";
  readonly openRepository: string | null;
  readonly setOpenRepository: (repository: string | null) => void;
}

/** What the panel is looking at: the thread, the folder, its git status and the selection. */
export function useDiffPanelSource(input: DiffPanelSourceInput) {
  const thread = useDiffPanelThread(input.composerDraftTarget);
  const { routeThreadRef, activeThread, diffEnvironmentId, diffSelectionRef } = thread;
  const activeCwd = resolveDiffPanelCwd(thread.projectCwd, input.openRepository);
  const environment = useDiffPanelEnvironment(diffEnvironmentId, activeCwd);
  const { gitStatusQuery } = environment;
  const { diffSelection, openRepositoryInTab } = useDiffPanelSelection(
    diffSelectionRef,
    input.initialGitScope,
    input.setOpenRepository,
  );
  const { scmStatus, setScmOverride } = useScmStatusOverride(gitStatusQuery.data ?? null);

  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const selection = describeDiffSelection(diffSelection);
  const turns = useDiffPanelTurns(
    activeThread,
    routeThreadRef,
    diffSelection,
    selection.selectedTurnId,
  );
  const reviewSection = describeReviewSection(
    routeThreadRef,
    turns.selectedTurn,
    turns.selectedCheckpointTurnCount,
  );
  return {
    ...thread,
    ...environment,
    ...selection,
    ...turns,
    ...reviewSection,
    activeCwd,
    openRepositoryInTab,
    scmStatus,
    setScmOverride,
    isGitRepo,
  };
}

type DiffPanelSource = ReturnType<typeof useDiffPanelSource>;

interface DiffPanelPatchViewInput {
  readonly source: DiffPanelSource;
  readonly viewOptions: DiffViewOptions;
  readonly resolvedTheme: DiffFilesViewProps["resolvedTheme"];
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly codeViewRef: RefObject<AnnotatableCodeViewHandle | null>;
}

/** The selection's patch, kept fresh, parsed into files, and wired to the file rows. */
export function useDiffPanelPatchView(input: DiffPanelPatchViewInput) {
  const { source, viewOptions, codeViewRef } = input;
  const { activeThread, collapseScopeKey, selectedTurn, selectedTurnId } = source;
  const { collapsedDiffFileKeys, setCollapsedDiffFiles } = useCollapsedDiffFiles(collapseScopeKey);
  const patch = useSelectedDiffPatch({
    ...source,
    diffIgnoreWhitespace: viewOptions.diffIgnoreWhitespace,
  });
  const refreshSelectedPatch = useDiffAutoRefresh({
    refresh: patch.refresh,
    threadRevision: activeThread?.updatedAt ?? null,
    threadIsRunning: activeThread?.session?.status === "running",
    workingTreeRevision: source.gitStatusQuery.data,
    readsLiveTree: selectedTurn === undefined,
  });
  const files = useDiffFiles(
    patch.selectedPatch,
    input.resolvedTheme,
    selectedTurnId === null,
    collapsedDiffFileKeys,
  );
  useRevealSelectedFile(
    codeViewRef,
    files.codeViewFiles,
    source.selectedFilePath,
    source.selectedFileRevealRequestId,
  );
  const openDiffFile = useOpenDiffFile(
    source.routeThreadRef,
    source.activeCwd,
    source.openInPreferredEditor,
  );
  const { toggleDiffFileCollapsed, toggleDiffFileCollapse } = useDiffFileCollapseActions(
    setCollapsedDiffFiles,
    collapseScopeKey,
    files.diffFileKeys,
  );
  const filesView: DiffFilesViewProps = {
    codeViewRef,
    codeViewKey: collapseScopeKey ?? source.reviewSectionId,
    files: files.codeViewFiles,
    sectionId: source.reviewSectionId,
    sectionTitle: source.reviewSectionTitle,
    composerDraftTarget: input.composerDraftTarget,
    activeCwd: source.activeCwd,
    isWorkingTree: selectedTurnId === null,
    scmStatus: source.scmStatus,
    onDiscarded: (next) => {
      source.setScmOverride(next);
      refreshSelectedPatch.current();
    },
    onToggleFile: toggleDiffFileCollapsed,
    onOpenFile: openDiffFile,
    diffRenderMode: viewOptions.diffRenderMode,
    wordWrap: viewOptions.wordWrap,
    resolvedTheme: input.resolvedTheme,
  };
  return { patch, files, filesView, toggleDiffFileCollapse };
}
