/**
 * The detail/shell merge. loop's shell knows a session is running but not
 * which turn; the detail's live overlay does. Losing that id made the view
 * treat the running turn's messages as settled.
 */
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThread, EnvironmentThreadShell } from "./models.ts";
import { mergeEnvironmentThread } from "./threadDetail.ts";

const runningTurn = {
  turnId: "live-2026-10-06T19:36:11.610Z",
  state: "running",
  requestedAt: "2026-10-06T19:36:11.610Z",
  startedAt: "2026-10-06T19:36:11.610Z",
  completedAt: null,
  assistantMessageId: null,
};

function pair(shellSession: unknown, shellLatestTurn: unknown) {
  const detail = {
    environmentId: "env",
    id: "thread",
    latestTurn: runningTurn,
    session: { status: "running", activeTurnId: runningTurn.turnId },
  } as unknown as EnvironmentThread;
  const shell = {
    environmentId: "env",
    id: "thread",
    latestTurn: shellLatestTurn,
    session: shellSession,
  } as unknown as EnvironmentThreadShell;
  return mergeEnvironmentThread(detail, shell)!;
}

describe("mergeEnvironmentThread", () => {
  it("keeps the detail's running turn when the shell has none", () => {
    const merged = pair({ status: "running", activeTurnId: null }, null);
    expect(merged.latestTurn?.turnId).toBe(runningTurn.turnId);
    expect(merged.session?.activeTurnId).toBe(runningTurn.turnId);
  });

  it("still lets the shell's own turn win", () => {
    const shellTurn = { ...runningTurn, turnId: "shell-turn" };
    const merged = pair({ status: "running", activeTurnId: "shell-turn" }, shellTurn);
    expect(merged.latestTurn?.turnId).toBe("shell-turn");
    expect(merged.session?.activeTurnId).toBe("shell-turn");
  });

  it("keeps an idle shell idle", () => {
    expect(pair(null, null).session).toBeNull();
  });
});
