import type { ScopedThreadRef } from "@loop/contracts";
import { useRef, useState } from "react";
import type { DraftId } from "../composerDraftStore";
import { useTheme } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import type { AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { DiffPanelContent } from "./diffPanel/DiffPanelContent";
import { DiffPanelHeaderNav, DiffPanelToolbar } from "./diffPanel/DiffPanelHeader";
import { useDiffPanelPatchView, useDiffPanelSource } from "./diffPanel/useDiffPanelModel";
import { useDiffViewOptions } from "./diffPanel/useDiffViewOptions";

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  initialGitScope: "branch" | "unstaged";
  /**
   * The repository this panel is pinned to, when it was opened as its own tab
   * from a folder of repositories.
   */
  repositoryPath?: string;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  initialGitScope: initialGitScopeProp,
  repositoryPath: pinnedRepository,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [initialGitScope] = useState(initialGitScopeProp);
  const viewOptions = useDiffViewOptions(settings);
  /**
   * Which nested repository is open, when the project is a folder of them.
   *
   * Null means the list. Selecting one re-points every git query at that
   * repository's own path, so from there down this is an ordinary single-repo
   * diff — same base-ref picker, same scopes, same everything.
   */
  // A pinned tab IS that repository: there is nothing to navigate back to.
  const [openRepository, setOpenRepository] = useState<string | null>(pinnedRepository ?? null);
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);
  const source = useDiffPanelSource({
    composerDraftTarget,
    initialGitScope,
    openRepository,
    setOpenRepository,
  });
  const { patch, files, filesView, toggleDiffFileCollapse } = useDiffPanelPatchView({
    source,
    viewOptions,
    resolvedTheme,
    composerDraftTarget,
    codeViewRef,
  });
  const { activeCwd, selectedTurnId } = source;
  /** The list stands in for the diff only at the folder level. */
  const showingRepositoryList =
    openRepository === null && (patch.workspaceRepositories?.length ?? 0) > 0;

  const headerRow = (
    <>
      <DiffPanelHeaderNav
        showingRepositoryList={showingRepositoryList}
        showGitActions={selectedTurnId === null && !showingRepositoryList}
        activeCwd={activeCwd}
        diffSelectionRef={source.diffSelectionRef}
        composerDraftTarget={composerDraftTarget}
        openRepository={openRepository}
        isPinnedRepository={pinnedRepository !== undefined}
        onBackToRepositories={() => setOpenRepository(null)}
      />
      <DiffPanelToolbar
        fileCount={files.codeViewFiles.length}
        diffLineStat={files.diffLineStat}
        allDiffFilesCollapsed={files.allDiffFilesCollapsed}
        onToggleAllFiles={toggleDiffFileCollapse}
        viewOptions={viewOptions}
      />
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      <DiffPanelContent
        activeCwd={activeCwd}
        showingRepositoryList={showingRepositoryList}
        workspaceRepositories={patch.workspaceRepositories}
        onOpenRepository={source.openRepositoryInTab}
        isGitRepo={source.isGitRepo}
        hasNoCompletedTurns={
          selectedTurnId !== null && source.orderedTurnDiffSummaries.length === 0
        }
        viewport={{
          isSelectedPatchTruncated: patch.isSelectedPatchTruncated,
          selectedPatchError: patch.selectedPatchError,
          renderablePatch: files.renderablePatch,
          isLoadingSelectedPatch: patch.isLoadingSelectedPatch,
          isTurnSelected: source.selectedTurn !== undefined,
          hasNoNetChanges: patch.hasNoNetChanges,
          wordWrap: viewOptions.wordWrap,
          filesView,
        }}
      />
    </DiffPanelShell>
  );
}
