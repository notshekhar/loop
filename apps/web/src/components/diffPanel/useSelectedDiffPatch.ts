import type { ThreadId, TurnId } from "@loop/contracts";
import { useMemo } from "react";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import type { TurnDiffSummary } from "../../types";
import type { useDiffPanelEnvironment, useDiffPanelThread } from "./useDiffPanelTarget";

type DiffEnvironmentId = ReturnType<typeof useDiffPanelThread>["diffEnvironmentId"];
type ServerConfig = ReturnType<typeof useDiffPanelEnvironment>["serverConfig"];

interface SelectedDiffPatchInput {
  readonly diffEnvironmentId: DiffEnvironmentId;
  readonly activeThreadId: ThreadId | null;
  readonly activeCwd: string | undefined;
  readonly serverConfig: ServerConfig;
  readonly isGitRepo: boolean;
  readonly selectedTurnId: TurnId | null;
  readonly selectedTurn: TurnDiffSummary | undefined;
  readonly selectedCheckpointTurnCount: number | undefined;
  readonly selectedBaseRef: string | null;
  readonly diffIgnoreWhitespace: boolean;
}

/** The patch for the current selection: a turn's checkpoint diff, or the working tree. */
export function useSelectedDiffPatch(input: SelectedDiffPatchInput) {
  const { selectedTurn } = input;
  const activeCheckpointDiff = useSelectedCheckpointDiff(input);
  const branchDiffPreview = useBranchDiffPreview(input);
  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) => source.kind === "working-tree",
  );
  const gitDiff = selectedGitSource?.diff;
  const selectedPatch = selectedTurn ? activeCheckpointDiff.data?.diff : gitDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  return {
    /**
     * A folder of repositories, not one itself.
     *
     * There is no single branch, remote or base ref here — each repository
     * resolved its own — so the header says what it is comparing instead of
     * offering a ref picker that could not mean anything.
     */
    workspaceRepositories: branchDiffPreview.data?.workspaceRepositories ?? null,
    refresh: selectedTurn ? activeCheckpointDiff.refresh : branchDiffPreview.refresh,
    selectedPatch,
    isSelectedPatchTruncated: !selectedTurn && selectedGitSource?.truncated === true,
    isLoadingSelectedPatch: selectedTurn
      ? activeCheckpointDiff.isPending
      : branchDiffPreview.isPending,
    selectedPatchError: selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error,
    hasNoNetChanges: hasResolvedPatch && selectedPatch.trim().length === 0,
  };
}

function useSelectedCheckpointDiff(input: SelectedDiffPatchInput) {
  const { selectedCheckpointTurnCount, selectedTurn } = input;
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  return useCheckpointDiff(
    {
      environmentId: input.diffEnvironmentId,
      threadId: input.activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: input.diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : null,
    },
    { enabled: input.isGitRepo && selectedTurn !== undefined },
  );
}

function useBranchDiffPreview(input: SelectedDiffPatchInput) {
  const { diffEnvironmentId, activeCwd, serverConfig, selectedBaseRef, selectedTurnId } = input;
  const primaryBranchDiffPreview = useEnvironmentQuery(
    selectedTurnId === null && diffEnvironmentId && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: diffEnvironmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: input.diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const shouldRetryBranchDiffAtEnvironmentCwd =
    selectedTurnId === null &&
    primaryBranchDiffPreview.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackBranchDiffPreview = useEnvironmentQuery(
    shouldRetryBranchDiffAtEnvironmentCwd && diffEnvironmentId && serverConfig
      ? reviewEnvironment.diffPreview({
          environmentId: diffEnvironmentId,
          input: {
            cwd: serverConfig.cwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: input.diffIgnoreWhitespace,
          },
        })
      : null,
  );
  return shouldRetryBranchDiffAtEnvironmentCwd
    ? fallbackBranchDiffPreview
    : primaryBranchDiffPreview;
}
