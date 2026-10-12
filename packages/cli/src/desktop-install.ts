/**
 * `loop install desktop` — install the desktop app, or update it when it is
 * already there.
 *
 * The installing itself is `install-desktop.sh` / `install-desktop.ps1`, the
 * same scripts the website's one-liner runs, exactly as `loop upgrade` runs
 * `install.sh`: they own the download, the checksum, the macOS quarantine and
 * the Linux menu entry, and there is one copy of that logic, not two. What
 * this adds is knowing whether there is anything to do:
 *
 * - the installed app and its version: `Loop.app`'s Info.plist on macOS, and a
 *   `.loop-version` marker the scripts write on Linux and Windows;
 * - the newest release that actually carries a desktop build. The desktop is
 *   only rebuilt when its own version moves, so the latest release is often a
 *   CLI-only one with no desktop download in it.
 *
 * A packaged app's version is the release tag's (package-app.ts stamps the
 * CLI version at the tag), so the two compare directly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_SLUG } from "@notshekhar/loop-core";

export type DesktopPlatform = "darwin" | "linux" | "win32";
export type DesktopArch = "arm64" | "x64";

export interface InstalledDesktop {
    /** Where it lives: the .app on macOS, the install folder elsewhere. */
    readonly path: string;
    /** Its version, or null when this copy does not say (an older install). */
    readonly version: string | null;
}

export interface DesktopRelease {
    readonly tag: string;
    readonly version: string;
}

/** The release asset for a platform, named as apps/desktop/package-app.ts emits it. */
export function desktopAssetName(platform: DesktopPlatform, arch: DesktopArch): string {
    return `loop-desktop-${platform}-${arch}.${platform === "linux" ? "tar.gz" : "zip"}`;
}

/** Plain `x.y.z` comparison, a leading `v` and any prerelease tail ignored. */
export function compareDesktopVersions(a: string, b: string): number {
    const parse = (v: string) =>
        v
            .replace(/^v/, "")
            .split("-")[0]!
            .split(".")
            .map((n) => Number.parseInt(n, 10) || 0);
    const left = parse(a);
    const right = parse(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** `CFBundleShortVersionString` out of an Info.plist's XML. */
export function plistVersion(plist: string): string | null {
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return match?.[1]?.trim() || null;
}

interface FsLike {
    readonly exists: (path: string) => boolean;
    readonly read: (path: string) => string | null;
}

const realFs: FsLike = {
    exists: existsSync,
    read: (path) => {
        try {
            return readFileSync(path, "utf8");
        } catch {
            return null;
        }
    },
};

/** The installed desktop app, where the install scripts put it — null when there is none. */
export function findInstalledDesktop(
    platform: DesktopPlatform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
    fs: FsLike = realFs,
): InstalledDesktop | null {
    if (platform === "darwin") {
        for (const app of ["/Applications/Loop.app", join(home, "Applications", "Loop.app")]) {
            if (!fs.exists(app)) continue;
            const plist = fs.read(join(app, "Contents", "Info.plist"));
            return { path: app, version: plist ? plistVersion(plist) : null };
        }
        return null;
    }
    const dir =
        env.LOOP_DESKTOP_HOME ||
        (platform === "win32"
            ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "Loop")
            : join(home, ".local", "share", "loop-desktop"));
    const exe = join(dir, platform === "win32" ? "Loop.exe" : "Loop");
    if (!fs.exists(exe)) return null;
    const marker = fs.read(join(dir, ".loop-version"))?.trim();
    return { path: dir, version: marker || null };
}

/**
 * The newest published release that has this platform's desktop build.
 * Null when GitHub cannot be asked (offline, rate limited): the installer
 * then resolves it itself.
 */
export async function latestDesktopRelease(
    platform: DesktopPlatform,
    arch: DesktopArch,
    fetchImpl: typeof fetch = fetch,
): Promise<DesktopRelease | null> {
    const asset = desktopAssetName(platform, arch);
    try {
        const response = await fetchImpl(`https://api.github.com/repos/${REPO_SLUG}/releases?per_page=30`, {
            headers: { accept: "application/vnd.github+json" },
        });
        if (!response.ok) return null;
        const releases = (await response.json()) as Array<{
            tag_name?: string;
            draft?: boolean;
            prerelease?: boolean;
            assets?: Array<{ name?: string }>;
        }>;
        for (const release of releases) {
            if (release.draft || release.prerelease || !release.tag_name) continue;
            if (release.assets?.some((a) => a.name === asset)) {
                return { tag: release.tag_name, version: release.tag_name.replace(/^v/, "") };
            }
        }
        return null;
    } catch {
        return null;
    }
}

/** This machine's desktop target. Apple Silicon under Rosetta gets the native build. */
export function desktopTarget(): { platform: DesktopPlatform; arch: DesktopArch } | null {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return null;
    let arch: DesktopArch | null = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
    if (!arch) return null;
    if (platform === "darwin" && arch === "x64") {
        const translated = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" });
        if (translated.stdout?.trim() === "1") arch = "arm64";
    }
    return { platform, arch };
}

/** What to do, given what is installed and what is published. */
export function desktopPlan(
    installed: InstalledDesktop | null,
    latest: DesktopRelease | null,
    force: boolean,
): { action: "install" | "update" | "up-to-date"; from?: string; to?: string } {
    if (!installed) return { action: "install", ...(latest ? { to: latest.version } : {}) };
    if (!force && latest && installed.version && compareDesktopVersions(latest.version, installed.version) <= 0) {
        return { action: "up-to-date", from: installed.version };
    }
    return {
        action: "update",
        ...(installed.version ? { from: installed.version } : {}),
        ...(latest ? { to: latest.version } : {}),
    };
}

const SCRIPT_SH = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install-desktop.sh`;
const SCRIPT_PS1 = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install-desktop.ps1`;

export async function cmdInstallDesktop(opts: { force?: boolean } = {}): Promise<void> {
    const target = desktopTarget();
    if (!target) {
        console.error(`The desktop app is not built for ${process.platform}-${process.arch}.`);
        process.exitCode = 1;
        return;
    }
    const installed = findInstalledDesktop(target.platform);
    const latest = await latestDesktopRelease(target.platform, target.arch);
    const plan = desktopPlan(installed, latest, Boolean(opts.force));

    if (plan.action === "up-to-date") {
        console.log(`Loop desktop is up to date (v${plan.from}) — ${installed!.path}`);
        return;
    }
    if (plan.action === "update") {
        const from = plan.from ? `v${plan.from}` : "the installed copy";
        console.log(`▶ Updating Loop desktop ${from} → ${plan.to ? `v${plan.to}` : "the latest build"}`);
    } else {
        console.log(`▶ Installing Loop desktop ${plan.to ? `v${plan.to}` : "(latest build)"}`);
    }

    // Pinned to the release resolved above, so the script installs exactly
    // the build that was compared — it falls back on its own when unpinned.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (latest) env.LOOP_VERSION = latest.tag;
    const isWin = target.platform === "win32";
    const result = isWin
        ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${SCRIPT_PS1} | iex`], {
              stdio: "inherit",
              env,
          })
        : spawnSync("bash", ["-c", `curl -fsSL ${SCRIPT_SH} | bash`], { stdio: "inherit", env });
    if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        return;
    }
    if (plan.action === "update" && target.platform === "darwin") {
        console.log("  If Loop was open, quit and reopen it to start the new version.");
    }
}
