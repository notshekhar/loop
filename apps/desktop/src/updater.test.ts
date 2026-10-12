import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assetNameFor,
  compareVersions,
  checkForUpdate,
  downloadRelease,
  extractRelease,
  resolveInstallLayout,
  swapInstall,
  writeWindowsSwapScript,
} from "./updater";

const sandbox = () => mkdtemp(join(tmpdir(), "loop-updater-test-"));

describe("where the install lives", () => {
  test("a macOS bundle is the .app, not the folder holding it", () => {
    // execPath points three levels inside; replacing dirname would replace
    // Contents/MacOS and leave a bundle that cannot launch.
    const layout = resolveInstallLayout("/Applications/Loop.app/Contents/MacOS/Loop", "darwin");
    expect(layout.kind).toBe("bundle");
    expect(layout.root).toBe("/Applications/Loop.app");
  });

  test("a path that is not inside a bundle is refused", () => {
    // Better to fail than to compute a plausible-looking root and rename it.
    expect(() => resolveInstallLayout("/usr/local/bin/Loop", "darwin")).toThrow(/not an app bundle/);
  });

  test("linux and windows replace the directory holding the executable", () => {
    expect(resolveInstallLayout("/home/x/.local/share/loop-desktop/Loop", "linux").root).toBe(
      "/home/x/.local/share/loop-desktop",
    );
    expect(resolveInstallLayout("C:\\Users\\x\\Loop\\Loop.exe", "win32").kind).toBe("directory");
  });
});

describe("asset names match what the release publishes", () => {
  test("zip on macOS and windows, tar.gz on linux", () => {
    expect(assetNameFor("darwin", "arm64")).toBe("loop-desktop-darwin-arm64.zip");
    expect(assetNameFor("win32", "x64")).toBe("loop-desktop-win32-x64.zip");
    expect(assetNameFor("linux", "arm64")).toBe("loop-desktop-linux-arm64.tar.gz");
  });
});

describe("version comparison", () => {
  test("orders releases numerically, not as strings", () => {
    // The reason this is not a string compare: "0.16.9" > "0.16.10" lexically,
    // which would hide every update for the rest of the 0.16 line.
    expect(compareVersions("0.16.10", "0.16.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.16.9", "0.16.10")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe("checking for a release", () => {
  function fakeFetch(tag: string): typeof fetch {
    return (async () =>
      ({ url: `https://github.com/notshekhar/loop/releases/tag/${tag}`, ok: true }) as Response) as
      unknown as typeof fetch;
  }

  test("offers a newer release with the right asset urls", async () => {
    const release = await checkForUpdate({
      currentVersion: "0.16.9",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: fakeFetch("v0.16.11"),
    });
    expect(release?.version).toBe("0.16.11");
    expect(release?.assetUrl).toBe(
      "https://github.com/notshekhar/loop/releases/download/v0.16.11/loop-desktop-darwin-arm64.zip",
    );
    expect(release?.sha256Url).toBe(`${release?.assetUrl}.sha256`);
  });

  test("says nothing when the build is already current", async () => {
    const release = await checkForUpdate({
      currentVersion: "0.16.11",
      platform: "linux",
      arch: "x64",
      fetchImpl: fakeFetch("v0.16.11"),
    });
    expect(release).toBeNull();
  });

  test("never offers an older release than the one running", async () => {
    // A rolled-back release, or a local build ahead of what is published; being
    // dragged backwards is worse than showing nothing.
    const release = await checkForUpdate({
      currentVersion: "0.17.0",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: fakeFetch("v0.16.11"),
    });
    expect(release).toBeNull();
  });

  /**
   * The redirect resolves `latest`; a HEAD on an asset answers per URL; the
   * releases list answers with `releases`.
   */
  function githubFetch(latest: string, published: Record<string, boolean>, releases: unknown[]): typeof fetch {
    return (async (url: string) => {
      if (url.endsWith("/releases/latest")) {
        return { url: `https://github.com/notshekhar/loop/releases/tag/${latest}`, ok: true } as Response;
      }
      if (url.includes("/releases/download/")) {
        const tag = url.split("/releases/download/")[1]!.split("/")[0]!;
        return { url, ok: published[tag] === true } as Response;
      }
      return { ok: true, json: async () => releases } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  const asset = { name: "loop-desktop-darwin-arm64.zip" };

  test("a CLI-only latest release is not offered; the newest with a desktop build is", async () => {
    const release = await checkForUpdate({
      currentVersion: "0.21.12",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: githubFetch("v0.21.15", { "v0.21.14": true }, [
        { tag_name: "v0.21.15", assets: [{ name: "loop-darwin-arm64.tar.gz" }] },
        { tag_name: "v0.21.14", assets: [asset] },
      ]),
    });
    expect(release?.tag).toBe("v0.21.14");
    expect(release?.assetUrl).toContain("/v0.21.14/loop-desktop-darwin-arm64.zip");
  });

  test("nothing to offer when the newest desktop build is the one running", async () => {
    const release = await checkForUpdate({
      currentVersion: "0.21.14",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: githubFetch("v0.21.15", { "v0.21.14": true }, [
        { tag_name: "v0.21.15", assets: [] },
        { tag_name: "v0.21.14", assets: [asset] },
      ]),
    });
    expect(release).toBeNull();
  });

  test("a redirect that lands somewhere unexpected is an error, not a version", async () => {
    const bad = (async () =>
      ({ url: "https://github.com/login", ok: true }) as Response) as unknown as typeof fetch;
    await expect(
      checkForUpdate({ currentVersion: "0.1.0", platform: "darwin", arch: "arm64", fetchImpl: bad }),
    ).rejects.toThrow(/could not resolve/);
  });
});

describe("downloading", () => {
  /** A fetch that serves fixed bytes and a checksum, like the real release does. */
  function serve(body: string, digest: string): typeof fetch {
    return (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith(".sha256")) {
        return { ok: true, text: async () => `${digest}  loop-desktop.zip\n` } as Response;
      }
      return {
        ok: true,
        headers: new Headers({ "content-length": String(Buffer.byteLength(body)) }),
        body: new Blob([body]).stream(),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const release = {
    tag: "v9.9.9",
    version: "9.9.9",
    assetName: "loop-desktop-darwin-arm64.zip",
    assetUrl: "https://example.invalid/loop-desktop-darwin-arm64.zip",
    sha256Url: "https://example.invalid/loop-desktop-darwin-arm64.zip.sha256",
  };

  test("writes the asset when the checksum matches, and reports progress", async () => {
    const dir = await sandbox();
    try {
      const body = "pretend archive bytes";
      const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      const percents: number[] = [];
      const path = await downloadRelease({
        release,
        destinationDir: dir,
        fetchImpl: serve(body, digest),
        onProgress: (p) => percents.push(p),
      });
      expect(await readFile(path, "utf8")).toBe(body);
      expect(percents.at(-1)).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a corrupted download is deleted rather than installed", async () => {
    // The case that matters: 170MB over a flaky link. Replacing a working app
    // with a truncated one leaves nothing to retry from, so this must refuse.
    const dir = await sandbox();
    try {
      const wrong = "0".repeat(64);
      await expect(
        downloadRelease({ release, destinationDir: dir, fetchImpl: serve("bytes", wrong) }),
      ).rejects.toThrow(/checksum mismatch/);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing checksum stops the update", async () => {
    const dir = await sandbox();
    const noSum = (async (url: string | URL) =>
      String(url).endsWith(".sha256")
        ? ({ ok: false, status: 404 } as Response)
        : ({ ok: true, headers: new Headers(), body: new Blob(["x"]).stream() } as unknown as Response)) as unknown as typeof fetch;
    try {
      await expect(
        downloadRelease({ release, destinationDir: dir, fetchImpl: noSum }),
      ).rejects.toThrow(/no published checksum/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("unpacking", () => {
  test("macOS descends into the .app the archive carries", async () => {
    // `ditto --keepParent` puts Loop.app inside the zip; the other two archive
    // the directory contents. Returning the wrong level would install a folder
    // containing a bundle instead of the bundle.
    const dir = await sandbox();
    try {
      const staged = await extractRelease({
        archivePath: "/nonexistent.zip",
        platform: "darwin",
        workDir: dir,
        run: async (_cmd, args) => {
          const out = args[args.length - 1]!;
          await mkdir(join(out, "Loop.app", "Contents"), { recursive: true });
        },
      });
      expect(staged.endsWith("Loop.app")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an archive with no bundle is an error", async () => {
    const dir = await sandbox();
    try {
      await expect(
        extractRelease({
          archivePath: "/nonexistent.zip",
          platform: "darwin",
          workDir: dir,
          run: async () => undefined,
        }),
      ).rejects.toThrow(/did not contain a .app/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("linux unpacks in place", async () => {
    const dir = await sandbox();
    try {
      const staged = await extractRelease({
        archivePath: "/x.tar.gz",
        platform: "linux",
        workDir: dir,
        run: async () => undefined,
      });
      expect(staged).toBe(join(dir, "unpacked"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("swapping the install", () => {
  /** A fake install tree, so the dangerous half runs for real in a sandbox. */
  async function tree() {
    const dir = await sandbox();
    const root = join(dir, "Loop.app");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "version.txt"), "old");
    const staged = join(dir, "staged", "Loop.app");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "version.txt"), "new");
    return { dir, root, staged };
  }

  test("replaces the install and removes the backup", async () => {
    const { dir, root, staged } = await tree();
    try {
      await swapInstall({ layout: { kind: "bundle", root, backup: `${root}.old` }, stagedRoot: staged });
      expect(await readFile(join(root, "version.txt"), "utf8")).toBe("new");
      expect(existsSync(`${root}.old`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("restores the old copy when the new one cannot be moved in", async () => {
    // The failure that must never leave the machine without an application.
    const { dir, root } = await tree();
    try {
      await expect(
        swapInstall({
          layout: { kind: "bundle", root, backup: `${root}.old` },
          stagedRoot: join(dir, "does-not-exist"),
        }),
      ).rejects.toThrow();
      expect(existsSync(root)).toBe(true);
      expect(await readFile(join(root, "version.txt"), "utf8")).toBe("old");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stale backup from an earlier attempt does not block the swap", async () => {
    const { dir, root, staged } = await tree();
    try {
      await mkdir(`${root}.old`, { recursive: true });
      await writeFile(join(`${root}.old`, "junk.txt"), "left over");
      await swapInstall({ layout: { kind: "bundle", root, backup: `${root}.old` }, stagedRoot: staged });
      expect(await readFile(join(root, "version.txt"), "utf8")).toBe("new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The reported failure: `ENOTEMPTY … Loop.app.old/Contents/Resources`, on
   * every update, forever.
   *
   * The final cleanup is best-effort — the app is still running out of the
   * backup when it runs — so a leftover `Loop.app.old` is expected. Deleting it
   * used to be the FIRST thing a swap did, unguarded, so once one would not
   * delete, no update could ever start again.
   *
   * An undeletable directory is simulated the way the real one behaves:
   * unlinking an entry needs write permission on its parent.
   */
  test("a backup that cannot be deleted moves aside instead of failing the update", async () => {
    const { dir, root, staged } = await tree();
    const locked = join(`${root}.old`, "Contents");
    try {
      await mkdir(join(locked, "Resources"), { recursive: true });
      await writeFile(join(locked, "Resources", "app.asar"), "held");
      await chmod(locked, 0o500);

      await swapInstall({ layout: { kind: "bundle", root, backup: `${root}.old` }, stagedRoot: staged });

      // The update landed, which is the whole point: a backup nobody can
      // delete must not be able to stop one.
      expect(await readFile(join(root, "version.txt"), "utf8")).toBe("new");
      // The stuck directory is still there — a recursive delete removes what
      // it can before failing, so the tree is partly eaten, but the path
      // survives. That is what forced the swap to move aside to `.old-2`…
      expect(existsSync(join(`${root}.old`, "Contents", "Resources"))).toBe(true);
      // …and `.old-2` is gone again, cleaned up once the swap succeeded.
      expect(existsSync(`${root}.old-2`)).toBe(false);
    } finally {
      await chmod(locked, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the windows helper", () => {
  test("waits for this process, swaps, relaunches and deletes itself", async () => {
    // Windows keeps a running .exe locked, so the swap cannot happen in-process.
    const dir = await sandbox();
    try {
      const script = await writeWindowsSwapScript({
        layout: { kind: "directory", root: "C:\\App", backup: "C:\\App.old" },
        stagedRoot: "C:\\staged",
        pid: 4242,
        execPath: "C:\\App\\Loop.exe",
        workDir: dir,
      });
      const body = await readFile(script, "utf8");
      expect(body).toContain("PID eq 4242");
      expect(body).toContain('move "C:\\App" "C:\\App.old"');
      expect(body).toContain('move "C:\\staged" "C:\\App"');
      // Rollback, relaunch, self-delete.
      expect(body).toContain('if errorlevel 1 move "C:\\App.old" "C:\\App"');
      expect(body).toContain('start "" "C:\\App\\Loop.exe"');
      expect(body).toContain("del ");
      // CRLF: cmd.exe is unreliable with bare LF line endings.
      expect(body.includes("\r\n")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
