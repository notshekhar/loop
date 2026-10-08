import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { rememberAddedProject } from "./addedProjects.ts";
import type { LoopServerInfo } from "./serverConfig.ts";
import { buildShellSnapshot, type LoopSessionRow } from "./shell.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

/**
 * Answers `session.list` with the given rows through the desktop bridge, and
 * `server.info` with `info` when one is given (an older loop rejects it).
 */
async function snapshotOf(rows: readonly Partial<LoopSessionRow>[], info?: LoopServerInfo) {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: (method) =>
      method === "session.list"
        ? Promise.resolve(rows)
        : method === "server.info" && info
          ? Promise.resolve(info)
          : Promise.reject(new Error(`unexpected ${method}`)),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };
  try {
    return await Effect.runPromise(buildShellSnapshot());
  } finally {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  }
}

const row = (over: Partial<LoopSessionRow>): Partial<LoopSessionRow> => ({
  id: "01SESSION",
  cwd: "/Users/someone/project",
  createdAt: 1_700_000_000_000,
  mtime: 1_700_000_100_000,
  provider: "kimi",
  model: "kimi/k3",
  ...over,
});

describe("the shell snapshot", () => {
  it("groups sessions into one project per cwd", async () => {
    const snapshot = await snapshotOf([
      row({ id: "a", cwd: "/w/one" }),
      row({ id: "b", cwd: "/w/one" }),
      row({ id: "c", cwd: "/w/two" }),
    ]);
    expect(snapshot.projects.map((project) => project.id).toSorted()).toEqual(["/w/one", "/w/two"]);
    expect(snapshot.projects.find((project) => project.id === "/w/two")?.title).toBe("two");
    expect(snapshot.threads).toHaveLength(3);
  });

  it("drops a session whose cwd is unusable instead of losing every project", async () => {
    // loop's RPC does not validate cwd on session.create, so a row like this
    // really can be in the store. ProjectId is a non-empty string and
    // `projects` is a plain array, so letting it through fails the decode of
    // the WHOLE snapshot and the sidebar renders empty.
    const snapshot = await snapshotOf([
      row({ id: "good", cwd: "/w/one" }),
      row({ id: "empty-cwd", cwd: "" }),
      row({ id: "blank-cwd", cwd: "   " }),
    ]);
    expect(snapshot.projects.map((project) => project.id)).toEqual(["/w/one"]);
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["good"]);
  });

  it("survives provider ids the contract's slug rules reject", async () => {
    const snapshot = await snapshotOf([row({ id: "a", provider: "custom:pronto-gpt" })]);
    expect(snapshot.threads[0]?.modelSelection.instanceId).toBe("custom__pronto-gpt");
  });

  it("keeps a session with no model or first message renderable", async () => {
    const snapshot = await snapshotOf([row({ id: "a", model: "", provider: "" })]);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]?.title).toBe("Untitled");
  });

  it("reports a running session so the sidebar can count it", async () => {
    const snapshot = await snapshotOf([row({ id: "a", running: true, provider: "kimi" })]);
    expect(snapshot.threads[0]?.session?.status).toBe("running");
    expect(snapshot.threads[0]?.session?.providerName).toBe("kimi");
  });

  it("leaves a session that is not running null", async () => {
    // The merged thread takes its session from the shell, so an
    // always-present session would lock the composer's environment picker on
    // threads that are merely open.
    const snapshot = await snapshotOf([row({ id: "a", running: false })]);
    expect(snapshot.threads[0]?.session).toBeNull();
    expect((await snapshotOf([row({ id: "a" })])).threads[0]?.session).toBeNull();
  });

  it("shows an added folder before it has any session", async () => {
    rememberAddedProject("primary", "01PROJECTULID", "/w/fresh");
    const snapshot = await snapshotOf([row({ id: "a", cwd: "/w/one" })]);
    const fresh = snapshot.projects.find((project) => project.id === "01PROJECTULID");
    expect(fresh?.workspaceRoot).toBe("/w/fresh");
    expect(fresh?.title).toBe("fresh");
    // No thread yet — the sidebar row says "No sessions" rather than lying.
    expect(snapshot.threads.filter((thread) => thread.projectId === "01PROJECTULID")).toHaveLength(0);
  });

  it("hands an added folder over to its sessions without doubling the row", async () => {
    rememberAddedProject("primary", "01OTHERULID", "/w/claimed");
    const snapshot = await snapshotOf([row({ id: "a", cwd: "/w/claimed" })]);
    // One row for that folder, under the folder — not one under the folder and
    // one under the id the palette minted. (Asserted per-folder rather than
    // over the whole list: the added-projects registry is module state, so a
    // previous test's unclaimed folder is legitimately still in here.)
    expect(snapshot.projects.filter((project) => project.workspaceRoot === "/w/claimed")).toEqual([
      expect.objectContaining({ id: "/w/claimed" }),
    ]);
  });

  it("gives every project loop's configured default model", async () => {
    // A null here sent every new thread to the first provider in the list —
    // a fresh install ran xai/composer-2.5 whatever defaultModel said.
    rememberAddedProject("primary", "added-1", "/w/added");
    const snapshot = await snapshotOf([row({ id: "a", cwd: "/w/one" })], {
      defaults: { model: "custom:fixture/fixture", provider: "custom:fixture" },
    });
    const defaults = snapshot.projects.map((project) => project.defaultModelSelection);
    expect(defaults.length).toBeGreaterThanOrEqual(2);
    for (const selection of defaults) {
      expect(selection?.model).toBe("custom:fixture/fixture");
      expect(selection?.instanceId).toBeTruthy();
    }
  });

  it("leaves the project default unset on a loop that does not report one", async () => {
    const snapshot = await snapshotOf([row({ id: "a", cwd: "/w/one" })]);
    expect(snapshot.projects[0]?.defaultModelSelection).toBeNull();
  });

  it("orders threads newest first", async () => {
    const snapshot = await snapshotOf([
      row({ id: "old", mtime: 1_000 }),
      row({ id: "new", mtime: 9_000 }),
      row({ id: "mid", mtime: 5_000 }),
    ]);
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["new", "mid", "old"]);
  });
});
