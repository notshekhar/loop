import type { TrajectoryRecord } from "./trajectory";

export type TrajectoryCellKind =
  "system" | "user" | "context" | "compacted" | "message" | "tool" | "subtool";

export interface AssistantMetricDetail {
  timingRecorded: boolean;
  stepStartTime: number;
  firstTokenTime: number;
  completedTime: number;
}

export interface TrajectoryCellProps {
  index: number;
  kind: TrajectoryCellKind;
  text: string;
  startedAt: number | null;
  timeSeconds: number | null;
  isError: boolean;
  requestOnly?: boolean;
  assistantMetrics?: AssistantMetricDetail;
}

export interface TrajectoryTurnModel {
  turn: number | null;
  groups: { cells: TrajectoryCellProps[] }[];
}

export function trajectoryCellKind(record: TrajectoryRecord): TrajectoryCellKind {
  if (record.kind === "User") return "user";
  if (record.kind === "Tool") return record.parentId ? "subtool" : "tool";
  if (record.label === "Compaction") return "compacted";
  if (record.kind === "Assistant" || record.kind === "Thinking" || record.kind === "Plan")
    return "message";
  return "context";
}

/** Stable record indexes join the unfiltered overview to the searchable ledger. */
export function trajectoryTimelineTurns(
  records: readonly TrajectoryRecord[],
): TrajectoryTurnModel[] {
  const turns: TrajectoryTurnModel[] = [];
  records.forEach((record, index) => {
    let turn = turns.at(-1);
    if (!turn || turn.turn !== (record.turn || null)) {
      turn = { turn: record.turn || null, groups: [{ cells: [] }] };
      turns.push(turn);
    }
    turn.groups[0]!.cells.push({
      index,
      kind: trajectoryCellKind(record),
      text: record.summary,
      startedAt: record.startedAt,
      timeSeconds: record.durationMs === null ? null : record.durationMs / 1000,
      isError: record.status === "Failed",
    });
  });
  return turns;
}
