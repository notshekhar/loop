import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UpdateManager, type UpdateState } from "./updateManager";

/**
 * Every download makes a `loop-update-*` work dir under the OS temp dir, and
 * these tests download for real. Pointed at the system one, each run left
 * three more behind — 31 had piled up. They go in a temp root of their own.
 */
const realTmpdir = process.env["TMPDIR"];
let tempRoot = "";
beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "loop-update-tests-"));
  process.env["TMPDIR"] = tempRoot;
});
afterAll(async () => {
  if (realTmpdir === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = realTmpdir;
  await rm(tempRoot, { recursive: true, force: true });
});

/** A fetch that answers the latest-release redirect, a checksum and the bytes. */
function serveRelease(tag: string): typeof fetch {
  return (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("releases/latest")) return { url: `https://x/releases/tag/${tag}`, ok: true } as Response;
    if (href.endsWith(".sha256"))
      return {
        ok: true,
        text: async () => `${new Bun.CryptoHasher("sha256").update("body").digest("hex")}  a\n`,
      } as Response;
    return {
      ok: true,
      headers: new Headers({ "content-length": "4" }),
      body: new Blob(["body"]).stream(),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * A manager wired to fakes, so the sequencing is tested without a network or a
 * filesystem. The steps themselves are covered in updater.test.ts.
 */
function harness(input?: {
  readonly tag?: string;
  readonly currentVersion?: string;
  readonly enabled?: boolean;
  readonly failDownload?: boolean;
}) {
  const states: UpdateState[] = [];
  let restarted = 0;
  const relaunchedFrom: Array<string | null> = [];
  const detached: Array<{ command: string; args: readonly string[] }> = [];

  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("releases/latest")) {
      return { url: `https://x/releases/tag/${input?.tag ?? "v9.9.9"}`, ok: true } as Response;
    }
    if (href.endsWith(".sha256")) {
      if (input?.failDownload) return { ok: false, status: 404 } as Response;
      return {
        ok: true,
        text: async () => `${new Bun.CryptoHasher("sha256").update("body").digest("hex")}  a\n`,
      } as Response;
    }
    return {
      ok: true,
      headers: new Headers({ "content-length": "4" }),
      body: new Blob(["body"]).stream(),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const manager = new UpdateManager({
    currentVersion: input?.currentVersion ?? "1.0.0",
    platform: "linux",
    arch: "x64",
    execPath: "/opt/loop/Loop",
    run: async () => undefined,
    restart: (from) => {
      restarted += 1;
      relaunchedFrom.push(from);
    },
    spawnDetached: (command, args) => detached.push({ command, args }),
    fetchImpl,
    ...(input?.enabled === undefined ? {} : { enabled: input.enabled }),
  });
  manager.on("state", (state) => states.push(state));
  return { manager, states, restarted: () => restarted, relaunchedFrom, detached };
}

describe("checking", () => {
  test("moves idle -> checking -> available and names the version", async () => {
    const h = harness({ tag: "v9.9.9", currentVersion: "1.0.0" });
    const { state } = await h.manager.check();
    expect(h.states.map((s) => s.status)).toEqual(["checking", "available"]);
    expect(state.availableVersion).toBe("9.9.9");
    expect(state.checkedAt).not.toBeNull();
  });

  test("reports up-to-date without offering anything", async () => {
    const h = harness({ tag: "v1.0.0", currentVersion: "1.0.0" });
    const { state } = await h.manager.check();
    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
  });

  test("a check that ran says so, whatever it found", async () => {
    // The manual button reports its own outcome, so "did a request go out" has
    // to be answered honestly — it used to be hardcoded true at the IPC layer.
    expect((await harness({ tag: "v9.9.9" }).manager.check()).checked).toBe(true);
    expect((await harness({ tag: "v1.0.0", currentVersion: "1.0.0" }).manager.check()).checked).toBe(true);
  });

  test("a build without updates reports that nothing was checked", async () => {
    // A dev run out of the repo. Pressing the button must not look like a
    // check that found nothing.
    const h = harness({ enabled: false });
    const { checked, state } = await h.manager.check();
    expect(checked).toBe(false);
    expect(state.status).toBe("disabled");
  });

  test("a second check while one is in flight is refused, not queued", async () => {
    const h = harness({ tag: "v9.9.9" });
    const [first, second] = await Promise.all([h.manager.check(), h.manager.check()]);
    // Exactly one of them ran; the loser says so rather than reporting a
    // result it did not produce.
    expect([first.checked, second.checked].filter(Boolean)).toHaveLength(1);
  });

  test("a failed check still counts as having run", async () => {
    // checked:false means "nothing happened"; a network failure is something
    // happening, and its reason is on the state.
    const broken = new UpdateManager({
      currentVersion: "1.0.0",
      platform: "linux",
      arch: "x64",
      execPath: "/opt/loop/Loop",
      run: async () => undefined,
      restart: () => {},
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    const { checked, state } = await broken.check();
    expect(checked).toBe(true);
    expect(state.status).toBe("error");
  });

  test("a failure is retryable and keeps its reason", async () => {
    const h = harness();
    // A check that throws must not leave the pill in a dead end.
    const broken = new UpdateManager({
      currentVersion: "1.0.0",
      platform: "linux",
      arch: "x64",
      execPath: "/opt/loop/Loop",
      run: async () => undefined,
      restart: () => {},
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    const { state } = await broken.check();
    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.message).toContain("offline");
    expect(state.canRetry).toBe(true);
    expect(h.states.length).toBe(0);
  });
});

describe("downloading", () => {
  test("only runs after a check found something", async () => {
    const h = harness();
    // Nothing to download yet: the pill can only reach this once "available".
    const state = await h.manager.download();
    expect(state.status).toBe("idle");
  });

  test("ends downloaded, at 100 percent, naming the version", async () => {
    const h = harness({ tag: "v9.9.9" });
    await h.manager.check();
    const state = await h.manager.download();
    expect(state.status).toBe("downloaded");
    expect(state.downloadedVersion).toBe("9.9.9");
    expect(state.downloadPercent).toBe(100);
  });

  test("a failed download is retryable and does not claim a version", async () => {
    const h = harness({ tag: "v9.9.9", failDownload: true });
    await h.manager.check();
    const state = await h.manager.download();
    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("download");
    expect(state.downloadedVersion).toBeNull();
    expect(state.canRetry).toBe(true);
  });
});

describe("installing", () => {
  test("refuses until something has been downloaded", async () => {
    const h = harness({ tag: "v9.9.9" });
    await h.manager.check();
    // "available" is not "downloaded" — installing here would swap in nothing.
    await h.manager.install();
    expect(h.restarted()).toBe(0);
  });

  test("swaps and restarts once the download is staged", async () => {
    // A real install tree: the swap renames directories for real, so a made-up
    // path would fail here for reasons that have nothing to do with sequencing.
    const dir = await mkdtemp(join(tmpdir(), "loop-install-"));
    const installed = join(dir, "loop-desktop");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "version.txt"), "old");
    let restarted = 0;
    const relaunchedFrom: Array<string | null> = [];
    try {
      const manager = new UpdateManager({
        currentVersion: "1.0.0",
        platform: "linux",
        arch: "x64",
        execPath: join(installed, "Loop"),
        // Stands in for tar: writes what the new install should contain.
        run: async (_cmd, args) => {
          const out = args[args.length - 1]!;
          await mkdir(out, { recursive: true });
          await writeFile(join(out, "version.txt"), "new");
        },
        restart: (from) => {
          restarted += 1;
          relaunchedFrom.push(from);
        },
        fetchImpl: serveRelease("v9.9.9"),
      });
      await manager.check();
      await manager.download();
      await manager.install();
      expect(restarted).toBe(1);
      // The INSTALLED root, not the exec path: macOS reopens the bundle, and
      // only the caller knows how to reopen one.
      expect(relaunchedFrom).toEqual([installed]);
      // The install really was replaced, not merely reported as replaced.
      expect(await readFile(join(installed, "version.txt"), "utf8")).toBe("new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("windows hands the swap to a detached helper", async () => {
    // The running .exe is locked, so the swap cannot happen in-process.
    const detached: Array<{ command: string; args: readonly string[] }> = [];
    let restarted = 0;
    const relaunchedFrom: Array<string | null> = [];
    const manager = new UpdateManager({
      currentVersion: "1.0.0",
      platform: "win32",
      arch: "x64",
      execPath: "C:\\App\\Loop.exe",
      run: async () => undefined,
      restart: (from) => {
        restarted += 1;
        relaunchedFrom.push(from);
      },
      spawnDetached: (command, args) => detached.push({ command, args }),
      fetchImpl: (async (url: string | URL) => {
        const href = String(url);
        if (href.includes("releases/latest")) return { url: "https://x/releases/tag/v9.9.9", ok: true } as Response;
        if (href.endsWith(".sha256"))
          return {
            ok: true,
            text: async () => `${new Bun.CryptoHasher("sha256").update("body").digest("hex")}  a\n`,
          } as Response;
        return {
          ok: true,
          headers: new Headers({ "content-length": "4" }),
          body: new Blob(["body"]).stream(),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await manager.check();
    await manager.download();
    await manager.install();
    expect(detached[0]?.command).toBe("cmd.exe");
    expect(detached[0]?.args[0]).toBe("/c");
    // It still quits — the helper is what brings the app back.
    expect(restarted).toBe(1);
    // And it must ask for a QUIT, not a relaunch. Relaunching here starts a
    // new Loop.exe out of the very directory the helper is waiting to move,
    // so the move fails, the helper restores the backup, and the update
    // silently reverts to the old version.
    expect(relaunchedFrom).toEqual([null]);
  });
});

describe("when updating is switched off", () => {
  test("reports disabled and does nothing", async () => {
    // A dev run out of the repo: "replace the install directory" would mean
    // deleting a checkout.
    const h = harness({ enabled: false });
    expect(h.manager.state.status).toBe("disabled");
    await h.manager.check();
    await h.manager.download();
    await h.manager.install();
    expect(h.states.length).toBe(0);
    expect(h.restarted()).toBe(0);
  });
});
