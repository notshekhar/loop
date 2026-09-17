import { describe, expect, it } from "vite-plus/test";
import type { TrajectoryRecord } from "./trajectory";
import { trajectoryTimelineTurns } from "./trajectoryTimelineAdapter";
import {
  deriveTrajectoryTimeline,
  trajectoryTimelineFocusIndexes,
} from "./trajectoryTimelineModel";

const record = (
  id: string,
  kind: TrajectoryRecord["kind"],
  startedAt: number | null,
  durationMs: number | null,
  overrides: Partial<TrajectoryRecord> = {},
): TrajectoryRecord => ({
  id,
  kind,
  startedAt,
  durationMs,
  turn: 1,
  label: kind,
  summary: id,
  status: "Recorded",
  ...overrides,
});

describe("DeepSeek trajectory projections over Loop events", () => {
  it("defaults to equal-width sequential blocks on Input, Model, and Tools lanes", () => {
    const turns = trajectoryTimelineTurns([
      record("user", "User", 1000, null),
      record("thinking", "Thinking", 1001, 20),
      record("assistant", "Assistant", 1021, null),
      record("tool", "Tool", 1022, 500),
      record("nested", "Tool", null, null, { parentId: "tool" }),
      record("next", "User", 90000, null, { turn: 2 }),
    ]);
    const model = deriveTrajectoryTimeline(turns)!;
    expect(model.spans.map(({ lane, start, end }) => [lane, start, end])).toEqual([
      [0, 0, 1],
      [1, 1, 2],
      [1, 2, 3],
      [2, 3, 4],
      [2, 4, 5],
      [0, 5, 6],
    ]);
    expect(model.turnBoundaries).toEqual([
      { turn: 1, time: 0 },
      { turn: 2, time: 5 },
    ]);
    expect(model.spans[4]?.kind).toBe("subtool");
  });

  it("compresses idle gaps in Duration mode while preserving overlapping calls", () => {
    const turns = trajectoryTimelineTurns([
      record("first", "Tool", 1000, 100),
      record("parallel", "Tool", 1050, 150),
      record("later", "Tool", 5000, 50, { turn: 2 }),
    ]);
    const model = deriveTrajectoryTimeline(turns, "duration")!;
    expect(model.spans.map(({ start, end }) => [start, end])).toEqual([
      [1000, 1100],
      [1050, 1200],
      [1200, 1250],
    ]);
    expect(model.turnBoundaries[1]).toEqual({ turn: 2, time: 1200 });
  });

  it("keeps unknown running durations as points, and untimed nested records in sequence only", () => {
    const turns = trajectoryTimelineTurns([
      record("live", "Tool", 1000, null, { status: "Running" }),
      record("nested", "Tool", null, null, { parentId: "live" }),
    ]);
    expect(deriveTrajectoryTimeline(turns, "duration")?.spans).toMatchObject([
      { index: 0, start: 1000, end: 1000 },
    ]);
    expect(deriveTrajectoryTimeline(turns)?.spans).toHaveLength(2);
  });

  it("includes every record overlapping a selected interval, including its endpoints", () => {
    const turns = trajectoryTimelineTurns([
      record("first", "Tool", 1000, 100),
      record("parallel", "Tool", 1050, 150),
      record("last", "Tool", 1200, 50),
    ]);
    expect([
      ...trajectoryTimelineFocusIndexes(turns, { start: 1100, end: 1200 }, "duration"),
    ]).toEqual([0, 1, 2]);
    expect([...trajectoryTimelineFocusIndexes(turns, { start: 0.2, end: 0.8 })]).toEqual([0]);
  });
});
