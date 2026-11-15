/**
 * The update state machine behind the sidebar's update pill.
 *
 * The renderer already had a complete update UI — upstream's, carried in this
 * fork — sitting dead because nothing implemented its bridge. This is that
 * implementation, so the shape of the state below is not a new design: it is
 * `DesktopUpdateState` from the renderer's contract, and the status values are
 * the ones the pill already knows how to draw.
 *
 * The steps themselves live in `updater.ts`, which knows nothing about Electron
 * or about state. This module owns the sequencing, the one-at-a-time guard and
 * the notifications.
 */
import { EventEmitter } from "node:events";
import { rm } from "./installFs";

import {
  type Arch,
  type AvailableRelease,
  type Fetch,
  type InstallLayout,
  type Platform,
  type Run,
  checkForUpdate,
  clearQuarantine,
  downloadRelease,
  ensureExecutable,
  extractRelease,
  makeWorkDir,
  resolveInstallLayout,
  swapInstall,
  writeWindowsSwapScript,
} from "./updater.js";

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

/** Mirrors the renderer's `DesktopUpdateState`. */
export interface UpdateState {
  readonly enabled: boolean;
  readonly status: UpdateStatus;
  readonly channel: "latest";
  readonly currentVersion: string;
  readonly hostArch: string;
  readonly appArch: string;
  readonly runningUnderArm64Translation: boolean;
  readonly availableVersion: string | null;
  readonly downloadedVersion: string | null;
  readonly releaseNotes: ReadonlyArray<{ version: string; items: ReadonlyArray<string> }>;
  readonly downloadPercent: number | null;
  readonly checkedAt: string | null;
  readonly message: string | null;
  readonly errorContext: "check" | "download" | "install" | null;
  readonly canRetry: boolean;
}

export interface UpdateManagerOptions {
  readonly currentVersion: string;
  readonly platform: Platform;
  readonly arch: Arch;
  readonly execPath: string;
  readonly run: Run;
  /**
   * Leave, so the new copy can take over.
   *
   * `relaunchFrom` is the installed root to come back from — or null when
   * something else owns the relaunch and this process must ONLY quit. That is
   * not a nicety: on Windows the swap helper waits for this pid to disappear
   * before it moves any directory, so an app that relaunches itself on the way
   * out re-locks the install directory a moment before the helper tries to
   * move it. The move fails, the helper restores the backup, and the update
   * silently reverts.
   */
  readonly restart: (relaunchFrom: string | null) => void;
  /** Detaches the Windows swap helper, which must outlive this process. */
  readonly spawnDetached?: (command: string, args: readonly string[]) => void;
  readonly fetchImpl?: Fetch;
  readonly repo?: string;
  /**
   * Off when the app is not a real install — a dev run out of the repo, where
   * "replace the install directory" would mean deleting a checkout.
   */
  readonly enabled?: boolean;
}

export declare interface UpdateManager {
  on(event: "state", listener: (state: UpdateState) => void): this;
}

export class UpdateManager extends EventEmitter {
  #state: UpdateState;
  readonly #options: UpdateManagerOptions;
  #release: AvailableRelease | null = null;
  #stagedRoot: string | null = null;
  #workDir: string | null = null;
  /** One operation at a time; the pill's buttons are not debounced. */
  #busy = false;

  constructor(options: UpdateManagerOptions) {
    super();
    this.#options = options;
    const enabled = options.enabled ?? true;
    this.#state = {
      enabled,
      status: enabled ? "idle" : "disabled",
      channel: "latest",
      currentVersion: options.currentVersion,
      hostArch: options.arch,
      appArch: options.arch,
      runningUnderArm64Translation: false,
      availableVersion: null,
      downloadedVersion: null,
      releaseNotes: [],
      downloadPercent: null,
      checkedAt: null,
      message: null,
      errorContext: null,
      canRetry: false,
    };
  }

  get state(): UpdateState {
    return this.#state;
  }

  #set(patch: Partial<UpdateState>): void {
    this.#state = { ...this.#state, ...patch };
    this.emit("state", this.#state);
  }

  /**
   * Ask GitHub what the newest release is. Safe to call on a timer.
   *
   * `checked` says whether a request actually went out. The timer ignores it,
   * but a person who pressed a button has to be told when nothing happened —
   * a disabled build or a check already in flight both look identical to a
   * silent no-op otherwise.
   */
  async check(): Promise<{ checked: boolean; state: UpdateState }> {
    if (!this.#state.enabled || this.#busy) return { checked: false, state: this.#state };
    this.#busy = true;
    this.#set({ status: "checking", message: null, errorContext: null, canRetry: false });
    try {
      const release = await checkForUpdate({
        currentVersion: this.#options.currentVersion,
        platform: this.#options.platform,
        arch: this.#options.arch,
        ...(this.#options.repo === undefined ? {} : { repo: this.#options.repo }),
        ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
      });
      const checkedAt = new Date().toISOString();
      if (!release) {
        this.#release = null;
        this.#set({ status: "up-to-date", availableVersion: null, checkedAt });
        return { checked: true, state: this.#state };
      }
      this.#release = release;
      this.#set({ status: "available", availableVersion: release.version, checkedAt });
      return { checked: true, state: this.#state };
    } catch (error) {
      this.#fail("check", error);
      // The check ran; it failed. `status: "error"` carries the reason, and
      // reporting checked:false here would read as "nothing happened".
      return { checked: true, state: this.#state };
    } finally {
      this.#busy = false;
    }
  }

  /** Fetch and verify the asset, then unpack it next to the install. */
  async download(): Promise<UpdateState> {
    if (!this.#state.enabled || this.#busy) return this.#state;
    const release = this.#release;
    if (!release) return this.#state;
    this.#busy = true;
    this.#set({ status: "downloading", downloadPercent: 0, message: null, errorContext: null });
    try {
      const workDir = await makeWorkDir();
      this.#workDir = workDir;
      const archive = await downloadRelease({
        release,
        destinationDir: workDir,
        ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
        onProgress: (percent) => this.#set({ downloadPercent: percent }),
      });
      const stagedRoot = await extractRelease({
        archivePath: archive,
        platform: this.#options.platform,
        workDir,
        run: this.#options.run,
      });
      await ensureExecutable(stagedRoot, this.#options.platform);
      if (this.#options.platform === "darwin") {
        await clearQuarantine(stagedRoot, this.#options.run);
      }
      this.#stagedRoot = stagedRoot;
      this.#set({
        status: "downloaded",
        downloadedVersion: release.version,
        downloadPercent: 100,
      });
      return this.#state;
    } catch (error) {
      await this.#cleanup();
      this.#fail("download", error);
      return this.#state;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Put the new copy in place and restart.
   *
   * On macOS and Linux the swap happens here and the process then relaunches
   * itself. On Windows a running executable is locked, so the work is handed to
   * a detached script that waits for this process to exit — which means
   * `install` there ends by quitting, and the relaunch is the script's job.
   */
  async install(): Promise<UpdateState> {
    if (!this.#state.enabled || this.#busy) return this.#state;
    if (this.#state.status !== "downloaded" || !this.#stagedRoot) return this.#state;
    this.#busy = true;
    try {
      const layout: InstallLayout = resolveInstallLayout(
        this.#options.execPath,
        this.#options.platform,
      );

      if (this.#options.platform === "win32") {
        const script = await writeWindowsSwapScript({
          layout,
          stagedRoot: this.#stagedRoot,
          pid: process.pid,
          execPath: this.#options.execPath,
          workDir: this.#workDir ?? layout.root,
        });
        const spawnDetached = this.#options.spawnDetached;
        if (!spawnDetached) throw new Error("no way to detach the update helper");
        spawnDetached("cmd.exe", ["/c", script]);
        // Quit only — `start ""` at the end of the script is the relaunch.
        this.#options.restart(null);
        return this.#state;
      }

      await swapInstall({ layout, stagedRoot: this.#stagedRoot });
      // The staged copy has moved into place; what is left is the downloaded
      // archive (~170MB), which nothing will ever read again.
      await this.#cleanup();
      // The INSTALLED root, not the exec path: on macOS the thing to reopen is
      // the bundle, and only the caller knows how to reopen one.
      this.#options.restart(layout.root);
      return this.#state;
    } catch (error) {
      this.#fail("install", error);
      return this.#state;
    } finally {
      this.#busy = false;
    }
  }

  async #cleanup(): Promise<void> {
    if (this.#workDir) await rm(this.#workDir, { recursive: true, force: true }).catch(() => undefined);
    this.#workDir = null;
    this.#stagedRoot = null;
  }

  /**
   * Report a failure without losing what was already known.
   *
   * `canRetry` is what re-arms the pill's button: every one of these is a
   * network or filesystem fault that a second attempt can genuinely fix, and a
   * dead-ended error row with no way forward is worse than no row.
   */
  #fail(context: "check" | "download" | "install", error: unknown): void {
    this.#set({
      status: "error",
      errorContext: context,
      message: error instanceof Error ? error.message : String(error),
      canRetry: true,
      downloadPercent: null,
    });
  }
}
