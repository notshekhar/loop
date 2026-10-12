import { describe, expect, it } from "vite-plus/test";

import { splitSpawnedMembers } from "./teamPresentation";

describe("a spawn row's threads", () => {
  const members = [
    { id: "S1", title: "TUI client check" },
    { id: "S2", title: "Desktop client check" },
    { id: "S5", title: "Reconnect seq bugs" },
  ];
  const output =
    'Started 1 thread (team tm_1):\n- "Reconnect seq bugs" — id S5\n\nThey are working.\n\n' +
    'Also in your team (finished threads keep their context):\n- "TUI client check" — done — id S1\n- "Desktop client check" — done — id S2';

  it("lists this call's threads, then keeps every earlier thread under them", () => {
    const { started, others } = splitSpawnedMembers(members, output, []);
    expect(started.map((m) => m.id)).toEqual(["S5"]);
    expect(others.map((m) => m.id)).toEqual(["S1", "S2"]);
  });

  it("falls back to the asked titles before the result arrives", () => {
    const { started, others } = splitSpawnedMembers(members, null, ["Desktop client check"]);
    expect(started.map((m) => m.id)).toEqual(["S2"]);
    expect(others.map((m) => m.id)).toEqual(["S1", "S5"]);
  });
});
