/**
 * In-app updates for the desktop shell.
 *
 * Electron's own `autoUpdater` is not an option here: on macOS it is Squirrel.Mac,
 * which refuses to install into an app that is not Developer-ID signed, and these
 * builds are ad-hoc signed (`codesign` reports `adhoc`, no TeamIdentifier). The
 * same is true of electron-updater. So this does what `install-desktop.sh`
 * already does, in-process: resolve the latest release, download the platform's
 * asset, check it against the published sha256, and swap the installed copy.
 *
 * The whole module is written against injected `fetch`/`run`/paths rather than
 * reaching for globals, because the risky half — replacing a directory that the
 * running program lives in — is only trustworthy if a test can drive it against
 * a fake install tree. Nothing here touches Electron; `main.ts` owns that seam.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_REPO = "notshekhar/loop";

export type Platform = "darwin" | "win32" | "linux";
export type Arch = "arm64" | "x64";

/**
 * Where the installed application actually lives, and what has to be replaced.
 *
 * `bundle` is macOS: the unit is `Loop.app`, a directory, and `execPath` points
 * three levels inside it (`Loop.app/Contents/MacOS/Loop`). `directory` is Linux
 * and Windows, where the unit is the folder holding the executable. Getting this
 * wrong would replace the wrong directory, so it is derived rather than guessed
 * and it refuses anything that does not look like an install.
 */
export interface InstallLayout {
  readonly kind: "bundle" | "directory";
  /** The directory that gets replaced wholesale. */
  readonly root: string;
  /** Where the new copy is moved aside to, so a failure can be undone. */
  readonly backup: string;
}

export function resolveInstallLayout(execPath: string, platform: Platform): InstallLayout {
  if (platform === "darwin") {
    // .../Loop.app/Contents/MacOS/Loop  ->  .../Loop.app
    const root = resolve(dirname(execPath), "..", "..");
    if (!root.endsWith(".app")) {
      throw new Error(`not an app bundle: ${execPath}`);
    }
    return { kind: "bundle", root, backup: `${root}.old` };
  }
  const root = dirname(execPath);
  return { kind: "directory", root, backup: `${root}.old` };
}

/** The release asset for this platform, named exactly as `package-app.ts` emits it. */
export function assetNameFor(platform: Platform, arch: Arch): string {
  const extension = platform === "linux" ? "tar.gz" : "zip";
  return `loop-desktop-${platform}-${arch}.${extension}`;
}

/**
 * Compare two `x.y.z` versions, ignoring a leading `v` and any prerelease tail.
 *
 * Deliberately not semver-complete: releases here are plain `vX.Y.Z` tags, and a
 * dependency for three integers would be worse than the twenty lines. Returns
 * negative when `a` is older.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface AvailableRelease {
  readonly tag: string;
  readonly version: string;
  readonly assetUrl: string;
  readonly sha256Url: string;
  readonly assetName: string;
}

export type Fetch = typeof fetch;

/**
 * The newest release, or null when this build is already it.
 *
 * Resolved through the `releases/latest` redirect rather than the API, which is
 * what `install.sh` does and for the same reason: the anonymous API is rate
 * limited to 60 requests an hour per IP, and a shared network burns that fast.
 * A redirect carries the tag in its final URL and costs nothing.
 */
export async function checkForUpdate(input: {
  readonly currentVersion: string;
  readonly platform: Platform;
  readonly arch: Arch;
  readonly repo?: string;
  readonly fetchImpl?: Fetch;
}): Promise<AvailableRelease | null> {
  const repo = input.repo ?? DEFAULT_REPO;
  const doFetch = input.fetchImpl ?? fetch;
  const response = await doFetch(`https://github.com/${repo}/releases/latest`, {
    method: "HEAD",
    redirect: "follow",
  });
  const tag = response.url.split("/").pop() ?? "";
  if (!/^v\d/.test(tag)) throw new Error(`could not resolve the latest release tag (got "${tag}")`);

  // Only ever forward. A machine running a build newer than the published one
  // (a local build, a rolled-back release) must not be dragged backwards.
  if (compareVersions(tag, input.currentVersion) <= 0) return null;

  const assetName = assetNameFor(input.platform, input.arch);
  const release = (releaseTag: string): AvailableRelease => {
    const base = `https://github.com/${repo}/releases/download/${releaseTag}`;
    return {
      tag: releaseTag,
      version: releaseTag.replace(/^v/, ""),
      assetName,
      assetUrl: `${base}/${assetName}`,
      sha256Url: `${base}/${assetName}.sha256`,
    };
  };

  // The desktop is rebuilt only when its own version moves, so the latest
  // release is often a CLI-only one with no desktop build in it. Offering it
  // put "Update available" in front of every user and then failed the
  // download on a missing checksum. Check the asset is really there first.
  const latest = release(tag);
  const head = await doFetch(latest.assetUrl, { method: "HEAD", redirect: "follow" }).catch(() => null);
  if (head?.ok) return latest;

  // Not in the latest: the newest release that has it, if that is still newer
  // than this build. The releases list is the rate-limited API, but this runs
  // a few times a day, and a failure just means "nothing to offer".
  try {
    const response = await doFetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return null;
    const releases = (await response.json()) as Array<{
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: Array<{ name?: string }>;
    }>;
    const withAsset = releases.find(
      (r) => !r.draft && !r.prerelease && r.tag_name && r.assets?.some((a) => a.name === assetName),
    );
    if (!withAsset?.tag_name) return null;
    if (compareVersions(withAsset.tag_name, input.currentVersion) <= 0) return null;
    return release(withAsset.tag_name);
  } catch {
    return null;
  }
}

/**
 * Download the asset and verify it before anything is allowed to touch the install.
 *
 * The checksum is not optional here, unlike in `install-desktop.sh` where a
 * missing one is tolerated. This runs unattended against a directory the user
 * cannot easily repair, and a truncated 170MB archive that installs is far worse
 * than one that refuses to: the app would be replaced by a broken copy and there
 * would be no working build left to retry from.
 */
export async function downloadRelease(input: {
  readonly release: AvailableRelease;
  readonly destinationDir: string;
  readonly fetchImpl?: Fetch;
  readonly onProgress?: (percent: number) => void;
}): Promise<string> {
  const doFetch = input.fetchImpl ?? fetch;
  await mkdir(input.destinationDir, { recursive: true });
  const target = join(input.destinationDir, input.release.assetName);
  await rm(target, { force: true });

  const expected = await readChecksum(doFetch, input.release.sha256Url);

  const response = await doFetch(input.release.assetUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${input.release.assetUrl}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  const hash = createHash("sha256");
  let received = 0;
  let lastReported = -1;

  // The DOM and node stream types disagree about ReadableStream; the value is
  // the same object either way.
  const source = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    if (total <= 0 || !input.onProgress) return;
    const percent = Math.min(100, Math.floor((received / total) * 100));
    // Only on change: a byte-level callback would be thousands of IPC messages.
    if (percent !== lastReported) {
      lastReported = percent;
      input.onProgress(percent);
    }
  });
  await pipeline(source, createWriteStream(target));

  const actual = hash.digest("hex");
  if (actual !== expected) {
    await rm(target, { force: true });
    throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
  }
  return target;
}

async function readChecksum(doFetch: Fetch, url: string): Promise<string> {
  const response = await doFetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`no published checksum at ${url} (${response.status})`);
  const text = await response.text();
  const digest = text.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`unusable checksum at ${url}`);
  return digest.toLowerCase();
}

export type Run = (command: string, args: readonly string[]) => Promise<void>;

/**
 * Unpack the archive and return the directory that should replace the install.
 *
 * The three archives are not shaped alike, because `package-app.ts` builds them
 * with each platform's native tool: macOS gets `ditto --keepParent`, so the zip
 * contains `Loop.app` itself, while Windows and Linux archive the *contents* of
 * the output directory. So macOS descends one level and the others do not.
 */
export async function extractRelease(input: {
  readonly archivePath: string;
  readonly platform: Platform;
  readonly workDir: string;
  readonly run: Run;
}): Promise<string> {
  const out = join(input.workDir, "unpacked");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  if (input.platform === "darwin") {
    // ditto, not unzip: it preserves the symlinks and extended attributes inside
    // a .app, and a bundle unpacked with plain unzip will not launch.
    await input.run("ditto", ["-xk", input.archivePath, out]);
    const entries = await readdir(out);
    const app = entries.find((entry) => entry.endsWith(".app"));
    if (!app) throw new Error("archive did not contain a .app bundle");
    return join(out, app);
  }

  if (input.platform === "linux") {
    await input.run("tar", ["-xzf", input.archivePath, "-C", out]);
    return out;
  }

  await input.run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath '${input.archivePath}' -DestinationPath '${out}' -Force`,
  ]);
  return out;
}

/**
 * Swap the staged copy into place, keeping the old one until it is proven.
 *
 * Two renames rather than a delete-then-move: a rename within a filesystem is
 * atomic, so there is no moment where the install directory is half-written. If
 * the second one fails the first is undone, which is the difference between a
 * failed update and no application at all.
 *
 * macOS and Linux can do this while running — the process holds its inodes, and
 * the files it still needs stay alive under the backup name. Windows cannot
 * (the loader keeps the .exe locked), so `installUpdate` hands that platform to
 * a detached helper instead and never calls this.
 */
/**
 * Delete a tree, retrying the errors that mean "busy right now".
 *
 * `fs.rm` documents `maxRetries` for exactly EBUSY/EMFILE/ENFILE/ENOTEMPTY/
 * EPERM, and a backup bundle hits them: the app is still running out of it,
 * and macOS is often indexing it at the same moment. Without the retries a
 * transient hold reads as a permanent failure.
 */
async function removeTree(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
}

/**
 * A backup path this swap can have to itself.
 *
 * The old code deleted `layout.backup` first and let a failure abort the whole
 * update. That made one stuck directory permanently fatal: the final cleanup is
 * best-effort (the app is still running out of the backup when it runs), so a
 * leftover `Loop.app.old` is normal — and once it was there and would not
 * delete, EVERY later update failed on its first line with
 * `ENOTEMPTY … Loop.app.old/Contents/Resources`, before anything was swapped.
 *
 * Removing it is still worth trying, because unbounded `.old-<n>` directories
 * in /Applications would be their own bug. But if it will not go, the swap
 * moves aside to a fresh name and carries on rather than refusing to update.
 */
async function freeBackupPath(preferred: string): Promise<string> {
  if (!existsSync(preferred)) return preferred;
  try {
    await removeTree(preferred);
    if (!existsSync(preferred)) return preferred;
  } catch {
    // Falls through to a unique name.
  }
  for (let n = 2; n < 100; n++) {
    const candidate = `${preferred}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
  // A hundred stuck backups is a different bug; say so rather than loop.
  throw new Error(`could not find a free backup path beside ${preferred}`);
}

/** Best-effort tidy of backups an earlier update could not remove. */
async function sweepStaleBackups(preferred: string): Promise<void> {
  for (let n = 2; n < 100; n++) {
    const candidate = `${preferred}-${n}`;
    if (!existsSync(candidate)) break;
    await removeTree(candidate).catch(() => undefined);
  }
}

export async function swapInstall(input: {
  readonly layout: InstallLayout;
  readonly stagedRoot: string;
}): Promise<void> {
  const { layout, stagedRoot } = input;
  if (!existsSync(stagedRoot)) throw new Error(`nothing staged at ${stagedRoot}`);

  const backup = await freeBackupPath(layout.backup);
  await rename(layout.root, backup);
  try {
    await rename(stagedRoot, layout.root);
  } catch (error) {
    // Put the working copy back before giving up.
    await rename(backup, layout.root).catch(() => undefined);
    throw error;
  }
  // Best-effort: the app is still running out of this, so on macOS it usually
  // cannot go until the relaunch. The next update will sweep it.
  await removeTree(backup).catch(() => undefined);
  await sweepStaleBackups(layout.backup).catch(() => undefined);
}

/**
 * Clear the quarantine flag macOS puts on anything downloaded.
 *
 * These builds are not notarized, so without this the replaced app is refused
 * at launch with a message about being damaged — the same reason
 * `install-desktop.sh` does it. Failure is non-fatal: an app that was never
 * quarantined has nothing to clear.
 */
export async function clearQuarantine(root: string, run: Run): Promise<void> {
  await run("xattr", ["-dr", "com.apple.quarantine", root]).catch(() => undefined);
}

/**
 * The Windows install path: a detached script that waits for us to exit.
 *
 * Windows keeps a running executable locked, so the swap cannot happen from
 * inside the process being replaced. The script waits for this pid to disappear,
 * moves the directories, relaunches, and deletes itself. `start ""` detaches the
 * relaunch so the new app does not die with the script's console.
 */
export async function writeWindowsSwapScript(input: {
  readonly layout: InstallLayout;
  readonly stagedRoot: string;
  readonly pid: number;
  readonly execPath: string;
  readonly workDir: string;
}): Promise<string> {
  const script = join(input.workDir, "loop-update.cmd");
  const body = [
    "@echo off",
    "setlocal",
    `:wait`,
    `tasklist /FI "PID eq ${input.pid}" 2>NUL | find "${input.pid}" >NUL`,
    `if not errorlevel 1 (`,
    `  timeout /t 1 /nobreak >NUL`,
    `  goto wait`,
    `)`,
    `rmdir /S /Q "${input.layout.backup}" 2>NUL`,
    `move "${input.layout.root}" "${input.layout.backup}" >NUL`,
    `move "${input.stagedRoot}" "${input.layout.root}" >NUL`,
    `if errorlevel 1 move "${input.layout.backup}" "${input.layout.root}" >NUL`,
    `rmdir /S /Q "${input.layout.backup}" 2>NUL`,
    `start "" "${input.execPath}"`,
    `del "%~f0"`,
    "",
  ].join("\r\n");
  await writeFile(script, body, "utf8");
  return script;
}

/** A scratch directory for one update, under the OS temp dir. */
export async function makeWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "loop-update-"));
}

/**
 * Make the new Linux/macOS launcher executable again.
 *
 * A tar.gz preserves the bit, but a zip written on another platform may not, and
 * an install whose launcher lost `+x` cannot be started at all.
 */
export async function ensureExecutable(root: string, platform: Platform): Promise<void> {
  if (platform === "win32") return;
  const launcher =
    platform === "darwin" ? join(root, "Contents", "MacOS", "Loop") : join(root, "Loop");
  if (!existsSync(launcher)) return;
  await chmod(launcher, 0o755).catch(() => undefined);
}

