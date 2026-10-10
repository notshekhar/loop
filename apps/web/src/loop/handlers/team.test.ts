import { describe, expect, it } from "vite-plus/test";

import { teamSnapshotOf } from "./team.ts";

describe("loop's team.get, as the team panel reads it", () => {
  it("narrows a snapshot, naming every thread and routing it by this client's id", () => {
    const snapshot = teamSnapshotOf({
      teamId: "tm_1",
      stopped: false,
      lead: {
        id: "L",
        title: "Add CSV export",
        role: "lead",
        state: "running",
        running: true,
        usd: 0.1,
        teamUsd: 0,
        inputTokens: 10,
        outputTokens: 1,
      },
      members: [
        {
          id: "A",
          title: "Endpoint",
          role: "member",
          state: "done",
          running: false,
          usd: 0.2,
          teamUsd: 0.15,
          inputTokens: 20,
          outputTokens: 2,
        },
        { title: "no id — dropped" },
      ],
      board: [
        { key: "contract", body: "GET /export", from: { id: "A", title: "Endpoint" }, ts: 5 },
      ],
      cost: { usd: 0.3, inputTokens: 30, outputTokens: 3, estimated: false },
    });
    expect(snapshot?.lead).toMatchObject({ id: "L", threadId: "L", running: true });
    expect(snapshot?.members.map((m) => [m.title, m.state, m.usd - m.teamUsd])).toEqual([
      ["Endpoint", "done", 0.05000000000000002],
    ]);
    expect(snapshot?.board[0]).toEqual({
      key: "contract",
      body: "GET /export",
      fromTitle: "Endpoint",
      ts: 5,
    });
    expect(snapshot?.cost.usd).toBe(0.3);
  });

  it("reads anything else — not in a team, an older loop — as no team", () => {
    expect(teamSnapshotOf(null)).toBeNull();
    expect(teamSnapshotOf({ teamId: "tm_1" })).toBeNull();
  });
});
