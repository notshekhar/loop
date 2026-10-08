import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { LoopHost } from "../transport.ts";
import {
  loadMoreSessions,
  pinSession,
  registerEnvironmentHost,
  resetSessionPagingForTests,
  SESSION_PAGE,
  sessionWindow,
  setSearchPins,
  watchSessionFolder,
} from "./sessionPaging.ts";
import { buildShellSnapshot } from "./shell.ts";

/**
 * Infinite scroll over a host with more sessions than one page: the shell
 * holds the newest page, grows a page at a time, still lists every folder,
 * and never drops a thread someone has open.
 */

interface Row {
  id: string;
  cwd: string;
  createdAt: number;
  mtime: number;
  provider: string;
  model: string;
}

/** A host that answers `session.list` the way loop does: newest first, paged, by folder or id. */
function pagedHost(id: string, rows: Row[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const newest = [...rows].sort((a, b) => b.mtime - a.mtime);
  const host = {
    id,
    calls,
    call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "session.list") {
        let list = newest;
        if (typeof params.cwd === "string") list = list.filter((r) => r.cwd === params.cwd);
        if (Array.isArray(params.ids)) list = list.filter((r) => (params.ids as string[]).includes(r.id));
        const offset = typeof params.offset === "number" ? params.offset : 0;
        const limit = typeof params.limit === "number" ? params.limit : list.length;
        return Promise.resolve(list.slice(offset, offset + limit) as T);
      }
      if (method === "session.projects") {
        const folders = new Map<string, { cwd: string; count: number; createdAt: number; updatedAt: number }>();
        for (const r of newest) {
          const f = folders.get(r.cwd);
          if (f) {
            f.count++;
            f.createdAt = Math.min(f.createdAt, r.createdAt);
          } else folders.set(r.cwd, { cwd: r.cwd, count: 1, createdAt: r.createdAt, updatedAt: r.mtime });
        }
        return Promise.resolve([...folders.values()] as T);
      }
      return Promise.resolve({} as T);
    },
  };
  return host as unknown as LoopHost & { calls: typeof calls };
}

/** 100 sessions: the newest 90 in /work, the 10 oldest in /old. */
function hundred(): Row[] {
  return Array.from({ length: 100 }, (_, i) => ({
    id: `s${String(i).padStart(3, "0")}`,
    cwd: i < 10 ? "/old" : "/work",
    createdAt: i,
    mtime: 1_000 + i,
    provider: "xai",
    model: "grok",
  }));
}

const snapshot = (host: LoopHost) => Effect.runPromise(buildShellSnapshot(false, host));

describe("session paging", () => {
  beforeEach(() => resetSessionPagingForTests());

  it("lists the newest page, and says there is more", async () => {
    const host = pagedHost("h1", hundred());
    registerEnvironmentHost("env-1", "h1");
    const shell = await snapshot(host);
    expect(shell.threads).toHaveLength(SESSION_PAGE);
    expect(shell.threads[0]!.id).toBe("s099");
    expect(sessionWindow("env-1").hasMore).toBe(true);
  });

  it("still lists every folder, even one whose sessions are all older than the page", async () => {
    const host = pagedHost("h1", hundred());
    const shell = await snapshot(host);
    expect(shell.projects.map((p) => p.id).sort()).toEqual(["/old", "/work"]);
  });

  it("grows a page at a time until the host runs out", async () => {
    const host = pagedHost("h1", hundred());
    registerEnvironmentHost("env-1", "h1");
    await snapshot(host);
    loadMoreSessions("env-1");
    expect(sessionWindow("env-1").loading).toBe(true);
    expect((await snapshot(host)).threads).toHaveLength(SESSION_PAGE * 2);
    loadMoreSessions("env-1");
    expect((await snapshot(host)).threads).toHaveLength(100);
    expect(sessionWindow("env-1")).toEqual({ limit: SESSION_PAGE * 3, hasMore: false, loading: false });
    // Nothing left: asking again does not widen it.
    loadMoreSessions("env-1");
    expect(sessionWindow("env-1").limit).toBe(SESSION_PAGE * 3);
  });

  it("a folder being looked at gets its own page, whatever its age", async () => {
    const host = pagedHost("h1", hundred());
    registerEnvironmentHost("env-1", "h1");
    watchSessionFolder("env-1", "/old");
    const shell = await snapshot(host);
    expect(shell.threads.filter((t) => t.projectId === "/old")).toHaveLength(10);
    expect(sessionWindow("env-1", "/old").hasMore).toBe(false);
  });

  it("keeps an open thread and a search match in the shell though both are old", async () => {
    const host = pagedHost("h1", hundred());
    const unpin = pinSession("h1", "s001");
    setSearchPins("h1", ["s002"]);
    const ids = (await snapshot(host)).threads.map((t) => t.id);
    expect(ids).toContain("s001");
    expect(ids).toContain("s002");
    unpin();
    setSearchPins("h1", []);
    expect((await snapshot(host)).threads.map((t) => t.id)).not.toContain("s001");
  });

  it("asks the host for pages, not for everything", async () => {
    const host = pagedHost("h1", hundred());
    await snapshot(host);
    const lists = host.calls.filter((c) => c.method === "session.list");
    expect(lists.every((c) => typeof c.params.limit === "number" || Array.isArray(c.params.ids))).toBe(true);
  });
});
