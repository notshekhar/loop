import { MessageId, TurnId } from "@loop/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import { deriveTrajectoryRecords, filterTrajectoryRecords } from "./trajectory";

const at = "2026-09-14T10:00:00.000Z";
const user = (id: string): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: at,
  message: {
    id: MessageId.make(id),
    role: "user",
    text: "Check the project",
    turnId: null,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
});
const tool = (overrides: Record<string, unknown> = {}): TimelineEntry => ({
  id: "call-1",
  kind: "work",
  createdAt: at,
  entry: {
    id: "call-1",
    createdAt: at,
    turnId: TurnId.make("turn-1"),
    label: "Read src/main.ts",
    tone: "tool",
    loop: {
      tool: {
        name: "read",
        args: { path: "src/main.ts" },
        output: "export const result = 42",
        isError: false,
        isPartial: false,
        ...overrides,
      },
    },
  },
});

describe("trajectory session projection", () => {
  it("preserves the session order and associates null-id user prompts with numbered turns", () => {
    const records = deriveTrajectoryRecords([
      user("u1"),
      tool(),
      user("u2"),
      {
        id: "reply",
        kind: "message",
        createdAt: at,
        message: {
          id: MessageId.make("reply"),
          role: "assistant",
          text: "Done",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      },
    ]);
    expect(records.map(({ kind, turn }) => [kind, turn])).toEqual([
      ["User", 1],
      ["Tool", 1],
      ["User", 2],
      ["Assistant", 2],
    ]);
    expect(records[0]?.input).toBe("Check the project");
    expect(records[1]).toMatchObject({
      input: { path: "src/main.ts" },
      output: "export const result = 42",
      status: "Completed",
    });
  });

  it("updates a running call under the same key, using only recorded duration", () => {
    const running = deriveTrajectoryRecords([
      tool({ isPartial: true, output: undefined, startedAt: 1000, stats: { durationMs: 999 } }),
    ])[0]!;
    const settled = deriveTrajectoryRecords([
      tool({ startedAt: 1000, stats: { durationMs: 75 } }),
    ])[0]!;
    expect(running).toMatchObject({ status: "Running", startedAt: 1000, durationMs: null });
    expect(settled).toMatchObject({ id: running.id, durationMs: 75, status: "Completed" });
  });

  it("distinguishes failures, interruptions, and historical calls with unknown timings", () => {
    expect(deriveTrajectoryRecords([tool({ isError: true })])[0]?.status).toBe("Failed");
    expect(deriveTrajectoryRecords([tool({ interrupted: true })])[0]?.status).toBe(
      "Interrupted",
    );
    expect(deriveTrajectoryRecords([tool()])[0]?.durationMs).toBeNull();
    expect(
      deriveTrajectoryRecords([tool({ stats: { durationMs: -1 } })])[0]?.durationMs,
    ).toBeNull();
  });

  it("keeps nested activity in its parent turn without inventing timestamps or results", () => {
    const records = deriveTrajectoryRecords([
      user("u1"),
      tool({
        name: "task",
        droppedActivity: 2,
        activity: [
          { kind: "tool", name: "bash", input: { command: "bun test" } },
          { kind: "text", text: "Tests passed" },
        ],
      }),
    ]);
    expect(records[2]).toMatchObject({
      id: "work:call-1:child:2",
      parentId: "work:call-1",
      turn: 1,
      kind: "Tool",
      startedAt: null,
      durationMs: null,
      input: { command: "bun test" },
      status: "Recorded",
    });
    expect(records[2]?.output).toBeUndefined();
    expect(records[3]).toMatchObject({ kind: "Assistant", output: "Tests passed" });
  });

  it("preserves reasoning, compaction metadata, plans, and generic errors", () => {
    const records = deriveTrajectoryRecords([
      {
        id: "think",
        kind: "work",
        createdAt: at,
        entry: {
          id: "think",
          createdAt: at,
          label: "Thinking",
          tone: "thinking",
          loop: {
            thinking: { text: "Inspect the entry point", streaming: false, durationMs: 120 },
          },
        },
      },
      {
        id: "compact",
        kind: "work",
        createdAt: at,
        entry: {
          id: "compact",
          createdAt: at,
          label: "Compacted",
          tone: "info",
          loop: {
            compact: {
              running: false,
              summary: "Context summary",
              tokensBefore: 8000,
              tokensAfter: 2000,
            },
          },
        },
      },
      {
        id: "plan",
        kind: "proposed-plan",
        createdAt: at,
        proposedPlan: {
          id: "plan",
          turnId: null,
          planMarkdown: "# Fix it",
          createdAt: at,
          updatedAt: at,
          implementedAt: null,
          implementationThreadId: null,
        },
      },
      {
        id: "error",
        kind: "work",
        createdAt: at,
        entry: {
          id: "error",
          createdAt: at,
          label: "Connection failed",
          tone: "error",
          detail: "Socket closed",
        },
      },
    ]);
    expect(records[0]).toMatchObject({
      kind: "Thinking",
      output: "Inspect the entry point",
      durationMs: 120,
    });
    expect(records[1]).toMatchObject({
      label: "Compaction",
      output: "Context summary",
      details: { compact: { tokensBefore: 8000 } },
    });
    expect(records[2]).toMatchObject({ kind: "Plan", output: "# Fix it" });
    expect(records[3]).toMatchObject({ status: "Failed", output: "Socket closed" });
  });

  it("searches tool arguments and output as well as row labels without renumbering turns", () => {
    const records = deriveTrajectoryRecords([user("u1"), tool()]);
    expect(filterTrajectoryRecords(records, " MAIN.TS ")).toEqual([records[1]]);
    expect(filterTrajectoryRecords(records, "result = 42")).toEqual([records[1]]);
    expect(filterTrajectoryRecords(records, "missing")).toEqual([]);
    expect(filterTrajectoryRecords(records, " ")).toEqual(records);
  });
});
