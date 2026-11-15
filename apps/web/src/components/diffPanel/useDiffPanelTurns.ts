import type { ScopedThreadRef, TurnId } from "@loop/contracts";
import { useEffect, useMemo } from "react";
import { type DiffPanelSelection, useDiffPanelStore } from "../../diffPanelStore";
import { useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries";
import type { TurnDiffSummary } from "../../types";

/**
 * The panel is working-tree only, while the scope picker is gone. A stored
 * selection of "branch changes" would otherwise strand it there with no
 * control left to change it back, so the branch scope is not resolved here
 * at all.
 */
const REVIEW_SCOPE_ID = "unstaged";

/** The thread's turns, newest first, and the one the selection points at. */
export function useDiffPanelTurns(
  activeThread: Parameters<typeof useTurnDiffSummaries>[0],
  routeThreadRef: ScopedThreadRef | null,
  diffSelection: DiffPanelSelection,
  selectedTurnId: TurnId | null,
) {
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.turnId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  return { orderedTurnDiffSummaries, selectedTurn, selectedCheckpointTurnCount };
}

/** Ids and title of the section on screen, which key comments and collapse state. */
export function describeReviewSection(
  routeThreadRef: ScopedThreadRef | null,
  selectedTurn: TurnDiffSummary | undefined,
  selectedCheckpointTurnCount: number | undefined,
) {
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.turnId}` : REVIEW_SCOPE_ID;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : "Working tree";
  return { reviewSectionId, collapseScopeKey, reviewSectionTitle };
}
