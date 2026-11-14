import { describe, expect, it } from "vite-plus/test";

import {
  LEAD_LANE,
  splitSpawnedMembers,
  startedThreadIds,
  teamLaneFor,
  teamStatePresentation,
} from "./teamPresentation";

const output = [
  "Started 1 thread (team tm_1):",
  '- "Reconnect seq bugs" — id S5',
  "",
  "They are working in the background.",
  "",
  "Also in your team (finished threads keep their context; message one with send_message to give it more work):",
  '- "TUI client check" — done — id S1',
  '- "Desktop client check" — done — id S2',
].join("\n");

const members = [
  { id: "S1", title: "TUI client check" },
  { id: "S2", title: "Desktop client check" },
  { id: "S5", title: "Reconnect seq bugs" },
];

describe("a spawn card's threads", () => {
  it("reads the ids this call started, not the team listed after them", () => {
    expect(startedThreadIds(output)).toEqual(["S5"]);
    expect(startedThreadIds(undefined)).toEqual([]);
  });

  it("puts this call's threads first and keeps every other thread in the team", () => {
    const { started, others } = splitSpawnedMembers(members, output, ["Reconnect seq bugs"]);
    expect(started.map((m) => m.id)).toEqual(["S5"]);
    expect(others.map((m) => m.id)).toEqual(["S1", "S2"]);
  });

  it("matches by title while the result is still on its way", () => {
    const { started, others } = splitSpawnedMembers(members, undefined, ["TUI client check"]);
    expect(started.map((m) => m.id)).toEqual(["S1"]);
    expect(others.map((m) => m.id)).toEqual(["S2", "S5"]);
  });
});

describe("a thread's colour on the team rail", () => {
  const team = {
    lead: { id: "L" },
    members: Array.from({ length: 7 }, (_, index) => ({ id: `M${index}` })),
  };

  it("draws the lead as the blue trunk, and anyone unknown with it", () => {
    expect(teamLaneFor(team, "L")).toBe(LEAD_LANE);
    expect(teamLaneFor(team, "nobody")).toBe(LEAD_LANE);
    expect(teamLaneFor(null, "M0")).toBe(LEAD_LANE);
  });

  it("gives each thread its own hue in spawn order, wrapping past six", () => {
    const lanes = team.members.slice(0, 6).map((member) => teamLaneFor(team, member.id));
    expect(new Set(lanes).size).toBe(6);
    expect(lanes).not.toContain(LEAD_LANE);
    expect(teamLaneFor(team, "M6")).toBe(lanes[0]);
  });
});

describe("a team state's pill", () => {
  it("tints each state in its own hue", () => {
    expect(teamStatePresentation("running").chipClass).toContain("chip-blue");
    expect(teamStatePresentation("waiting").chipClass).toContain("chip-orange");
    expect(teamStatePresentation("done").chipClass).toContain("chip-green");
    expect(teamStatePresentation("failed").chipClass).toContain("chip-red");
    expect(teamStatePresentation("idle").chipClass).toContain("chip-neutral");
  });
});
