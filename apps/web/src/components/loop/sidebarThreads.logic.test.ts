import type { EnvironmentThreadShell } from "@loop/runtime/state/models";
import type { SidebarThreadRow, SidebarThreadSections } from "./sidebarThreads.logic";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarThreadSections,
  classifySidebarThread,
  rollupForProject,
  sectionsForProject,
  threadVisitKey,
} from "./sidebarThreads.logic";

const NOW = "2026-08-13T12:00:00.000Z";
const OPTIONS = { now: NOW, autoSettleAfterDays: null } as const;

/**
 * A plain, idle thread; each case turns on the one field it is about.
 *
 * Cast rather than built through the schema: every id on the shell is branded,
 * and decoding a full shell per case would bury what each test is actually
 * saying under twenty lines of fixture.
 */
function thread(overrides: Record<string, unknown> & { id: string }): EnvironmentThreadShell {
  return {
    environmentId: "env-1",
    projectId: "proj-loop",
    title: "A thread",
    modelSelection: null,
    runtimeMode: "local",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T11:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const stateOf = (shell: EnvironmentThreadShell) => classifySidebarThread(shell, OPTIONS).state;

describe("what a thread is doing", () => {
  it("puts a pending approval in front of everything else", () => {
    expect(stateOf(thread({ id: "a", hasPendingApprovals: true }))).toBe("needs-you");
  });

  it("counts a question the same as an approval", () => {
    expect(stateOf(thread({ id: "a", hasPendingUserInput: true }))).toBe("needs-you");
  });

  it("counts a finished plan as an ask — nobody accepts a plan they never saw", () => {
    const planned = thread({
      id: "a",
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestTurn: {
        turnId: "t1",
        state: "completed",
        startedAt: "2026-08-13T10:58:00.000Z",
        completedAt: "2026-08-13T10:59:00.000Z",
      },
    });
    expect(stateOf(planned)).toBe("needs-you");
  });

  it("ranks an ask above a live session — a running thread needs nothing from you", () => {
    const both = thread({
      id: "a",
      hasPendingApprovals: true,
      session: { status: "running" },
    });
    expect(stateOf(both)).toBe("needs-you");
  });

  it("reads a live session as working", () => {
    expect(
      stateOf(thread({ id: "a", session: { status: "running" } })),
    ).toBe("working");
    expect(
      stateOf(thread({ id: "a", session: { status: "starting" } })),
    ).toBe("working");
  });

  it("reads a user-settled thread as settled, not merely old", () => {
    const settled = thread({
      id: "a",
      settledOverride: "settled",
      settledAt: "2026-08-13T11:30:00.000Z",
    });
    expect(stateOf(settled)).toBe("settled");
  });

  it("refuses to settle a thread that is blocked on you, override or not", () => {
    const blocked = thread({
      id: "a",
      settledOverride: "settled",
      settledAt: "2026-08-13T11:30:00.000Z",
      hasPendingApprovals: true,
    });
    expect(stateOf(blocked)).toBe("needs-you");
  });

  it("leaves everything else in recent", () => {
    expect(stateOf(thread({ id: "a" }))).toBe("recent");
  });
});

describe("building the sections", () => {
  it("drops archived threads rather than shelving them", () => {
    const sections = buildSidebarThreadSections(
      [thread({ id: "a" }), thread({ id: "b", archivedAt: "2026-08-01T00:00:00.000Z" })],
      OPTIONS,
    );
    expect(sections.recent.map((row) => row.id)).toEqual(["a"]);
    expect(sections.settled).toHaveLength(0);
  });

  it("orders 'needs you' by the OLDEST ask, not the newest", () => {
    const asks = [
      thread({
        id: "recent-ask",
        hasPendingApprovals: true,
        latestTurn: {
          turnId: "t",
          state: "completed",
          startedAt: NOW,
          completedAt: "2026-08-13T11:59:00.000Z",
        },
      }),
      thread({
        id: "old-ask",
        hasPendingApprovals: true,
        latestTurn: {
          turnId: "t",
          state: "completed",
          startedAt: NOW,
          completedAt: "2026-08-13T09:00:00.000Z",
        },
      }),
    ];
    // The one that has been waiting three hours goes first — a question buried
    // under a newer question is how a thread gets forgotten.
    expect(buildSidebarThreadSections(asks, OPTIONS).needsYou.map((row) => row.id)).toEqual([
      "old-ask",
      "recent-ask",
    ]);
  });

  it("orders every other section newest first", () => {
    const sections = buildSidebarThreadSections(
      [
        thread({ id: "older", updatedAt: "2026-08-13T09:00:00.000Z" }),
        thread({ id: "newer", updatedAt: "2026-08-13T11:30:00.000Z" }),
      ],
      OPTIONS,
    );
    expect(sections.recent.map((row) => row.id)).toEqual(["newer", "older"]);
  });

  it("carries branch and worktree onto the row", () => {
    const [row] = buildSidebarThreadSections(
      [thread({ id: "a", branch: "feat/sidebar", worktreePath: "/tmp/wt" })],
      OPTIONS,
    ).recent;
    expect(row?.branch).toBe("feat/sidebar");
    expect(row?.worktreePath).toBe("/tmp/wt");
  });

  it("marks a finished turn you have not looked at", () => {
    const finished = thread({
      id: "a",
      latestTurn: {
        turnId: "t",
        state: "completed",
        startedAt: "2026-08-13T10:00:00.000Z",
        completedAt: "2026-08-13T10:30:00.000Z",
      },
    });
    const seen = buildSidebarThreadSections([finished], {
      ...OPTIONS,
      lastVisitedAtByKey: { [threadVisitKey("env-1", "a")]: "2026-08-13T11:00:00.000Z" },
    });
    const unseen = buildSidebarThreadSections([finished], {
      ...OPTIONS,
      lastVisitedAtByKey: { [threadVisitKey("env-1", "a")]: "2026-08-13T10:00:00.000Z" },
    });
    expect(seen.recent[0]?.status).toBeNull();
    expect(unseen.recent[0]?.status?.label).toBe("Completed");
  });
});

describe("what a collapsed project row says", () => {
  const sections = buildSidebarThreadSections(
    [
      thread({ id: "ask", hasPendingApprovals: true }),
      thread({ id: "live", session: { status: "running" } }),
      thread({ id: "idle" }),
      thread({ id: "done", settledOverride: "settled", settledAt: NOW }),
      thread({ id: "other-project", projectId: "proj-oboe", hasPendingApprovals: true }),
    ],
    OPTIONS,
  );

  it("counts what is waiting and what is running, not the total", () => {
    const rollup = rollupForProject(sections, "proj-loop");
    expect(rollup.needsYou).toBe(1);
    expect(rollup.working).toBe(1);
    // Settled threads are not "open" — the count is what is still live.
    expect(rollup.openCount).toBe(3);
  });

  it("dates a folder by its newest thread, settled ones included", () => {
    expect(rollupForProject(sections, "proj-loop").lastActivity).toBe(
      Date.parse("2026-08-13T11:00:00.000Z"),
    );
  });

  it("keeps another project's ask out of this project's rollup", () => {
    expect(rollupForProject(sections, "proj-oboe").needsYou).toBe(1);
    expect(rollupForProject(sections, "proj-loop").needsYou).toBe(1);
  });

  it("narrows every section to one project", () => {
    const mine = sectionsForProject(sections, "proj-oboe");
    expect(mine.needsYou.map((row) => row.id)).toEqual(["other-project"]);
    expect(mine.working).toHaveLength(0);
  });
});

describe("one folder on two paired machines", () => {
  const row = (id: string, environmentId: string) =>
    ({ id, environmentId, projectId: "/work/app" }) as unknown as SidebarThreadRow;
  const sections = {
    needsYou: [],
    working: [row("on-mac", "mac"), row("on-devbox", "devbox")],
    recent: [],
    settled: [],
  } as unknown as SidebarThreadSections;

  it("keeps each machine's threads under its own project", () => {
    expect(sectionsForProject(sections, "/work/app", "mac").working.map((r) => r.id)).toEqual([
      "on-mac",
    ]);
    expect(sectionsForProject(sections, "/work/app", "devbox").working.map((r) => r.id)).toEqual([
      "on-devbox",
    ]);
  });
});
