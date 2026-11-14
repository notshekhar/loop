/**
 * Package the desktop app into a distributable per platform.
 *
 * `build.ts` produces the app's own files (main, preload, renderer, and the
 * loop binary it spawns). This wraps those in an Electron runtime and emits a
 * single archive the installer can fetch:
 *
 *     bun package-app.ts                 # host platform
 *     bun package-app.ts darwin-arm64    # a specific target
 *
 * Output: release/loop-desktop-<platform>-<arch>.{zip,tar.gz}
 *
 * Packaging runs from a STAGING directory rather than this one. Electron
 * packager copies the app folder as-is, and bun's node_modules is a tree of
 * symlinks into a content-addressed store — copying that verbatim ships
 * dangling links. Staging is also what lets the bundled loop binary be the
 * TARGET's rather than the host's, which is the whole point of cross-packaging.
 */
import { packager } from "@electron/packager";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const stage = join(here, "stage");
const out = join(here, "release");

const pkg = await Bun.file(join(here, "package.json")).json();
/**
 * The shipped version is loop's own, not this private workspace's 0.0.1.
 *
 * packages/cli is where the product is versioned — it is what the release tags
 * track and what `loop --version` prints — so the desktop rides the same number
 * rather than inventing a second one for users to reconcile.
 */
const cliPkg = await Bun.file(join(repo, "packages", "cli", "package.json")).json();
const version = process.env.LOOP_VERSION?.replace(/^v/, "") || cliPkg.version || "0.0.0";
const electronVersion = String(pkg.dependencies?.electron ?? "").replace(/^[^0-9]*/, "");

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const [platform, arch] = target.split("-");
if (!platform || !arch) throw new Error(`bad target: ${target} (expected <platform>-<arch>)`);

/**
 * The loop binary for the TARGET, not the host.
 *
 * `build.ts` copies the host's because it builds for running locally. A
 * darwin-arm64 machine packaging linux-x64 would otherwise ship a Mach-O
 * binary the app spawns and fails to exec, and the failure surfaces as "loop
 * exited immediately" long after the build looked fine.
 */
/**
 * The CLI calls Windows "windows"; Electron and node call it "win32". The two
 * naming schemes meet here, and getting it wrong looks like a missing build
 * rather than a wrong path.
 */
const cliPlatform = platform === "win32" ? "windows" : platform;
const cliBinaryDir = join(repo, "packages", "cli", "dist", "bin", `${cliPlatform}-${arch}`);
const cliBinary = join(cliBinaryDir, platform === "win32" ? "loop.exe" : "loop");
if (!existsSync(cliBinary)) {
    throw new Error(
        `no loop binary for ${target} at ${cliBinary}\n` +
            `build it first: cd packages/cli && bun build-bin.ts bun-${cliPlatform}-${arch}`,
    );
}

/**
 * node-pty is a native addon, so it cannot be bundled and has to ship as a real
 * package. Its loader picks a binding at runtime from `prebuilds/<platform>-
 * <arch>/`, falling back to a `build/Release` compiled at install time. Since
 * 1.2.0-beta upstream publishes prebuilds for linux as well as darwin and
 * win32, so every target we ship is cross-packageable from any host; the
 * `build/Release` branch stays as the fallback for a target that ever loses
 * its prebuild. The absence of both is fatal here rather than a terminal that
 * mysteriously never opens.
 */
const ptySource = join(here, "node_modules", "node-pty");
if (!existsSync(ptySource)) throw new Error(`node-pty not installed at ${ptySource}`);
const hasPrebuild = existsSync(join(ptySource, "prebuilds", `${platform}-${arch}`));
const hasCompiled = existsSync(join(ptySource, "build", "Release"));
if (!hasPrebuild && !hasCompiled) {
    throw new Error(
        `node-pty has no binding for ${target}.\n` +
            `Expected ${ptySource}/prebuilds/${platform}-${arch}/. If upstream dropped that ` +
            `prebuild, package this target on a ${platform} runner where \`bun install\` compiles it.`,
    );
}

console.log(`▶ packaging loop desktop ${version} for ${target} (electron ${electronVersion})`);

// ─── stage ────────────────────────────────────────────────────────────────
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

await cp(join(here, "dist"), join(stage, "dist"), { recursive: true, dereference: true });
// Overwrite the host binary build.ts laid down with the target's.
await mkdir(join(stage, "dist", "bin"), { recursive: true });
await cp(cliBinary, join(stage, "dist", "bin", platform === "win32" ? "loop.exe" : "loop"), {
    dereference: true,
});
await cp(ptySource, join(stage, "node_modules", "node-pty"), {
    recursive: true,
    dereference: true,
});
await pruneNodePty(join(stage, "node_modules", "node-pty"));

/**
 * Drop node-pty's bindings for every other target.
 *
 * The package carries prebuilds for all six platform/arch pairs plus the
 * Windows-only ConPTY DLLs, and the loader only ever reads its own
 * `prebuilds/<platform>-<arch>/`. MEASURED in a darwin-arm64 app: 25MB of
 * other targets' binaries, 7MB of the release zip.
 */
async function pruneNodePty(dir: string): Promise<void> {
    const prebuilds = join(dir, "prebuilds");
    for (const entry of existsSync(prebuilds) ? await readdir(prebuilds) : []) {
        if (entry !== `${platform}-${arch}`) await rm(join(prebuilds, entry), { recursive: true, force: true });
    }
    if (platform !== "win32") await rm(join(dir, "third_party", "conpty"), { recursive: true, force: true });
}

/**
 * A minimal manifest, not a copy of this workspace's.
 *
 * The real one carries workspace protocol deps (`@notshekhar/loop-core:
 * workspace:*`) that mean nothing outside the monorepo, and an `electron`
 * dependency that would have packager try to bundle the runtime it is already
 * wrapping the app in.
 */
await writeFile(
    join(stage, "package.json"),
    `${JSON.stringify(
        {
            name: "loop-desktop",
            productName: "Loop",
            version,
            private: true,
            main: "dist/main/index.cjs",
            /**
             * `author` and `description` are required, not decoration.
             *
             * Packager stamps them into the Windows executable's version
             * resource as CompanyName and FileDescription, and REFUSES to build
             * a win32 target without an author — while packaging darwin and
             * linux perfectly happily without one. Omitting them therefore
             * fails exactly one leg of the matrix, and only on the platform
             * that is slowest to find out about.
             */
            author: "notshekhar",
            description: "Coding agent",
            dependencies: { "node-pty": pkg.dependencies["node-pty"] },
        },
        null,
        2,
    )}\n`,
);

// ─── icon ─────────────────────────────────────────────────────────────────
// Packager wants a platform-native format and silently falls back to the
// default Electron icon when handed the wrong one.
const icon =
    platform === "darwin"
        ? join(repo, "branding", "loop.icns")
        : platform === "win32"
          ? join(repo, "branding", "favicon.ico")
          : join(repo, "branding", "icon-512.png");

// ─── package ──────────────────────────────────────────────────────────────
const [appPath] = await packager({
    dir: stage,
    out,
    platform,
    arch,
    electronVersion,
    appVersion: version,
    name: "Loop",
    appBundleId: "chat.oboe.loop",
    icon: existsSync(icon) ? icon : undefined,
    overwrite: true,
    /**
     * Anything that gets EXECUTED has to live outside the archive.
     *
     * asar is a read-only container the OS cannot exec out of, so a binary
     * inside it can be read but never spawned. Packager unpacks `*.node` by
     * itself, which is why node-pty's bindings work and hides the problem —
     * but the loop binary the app shells out to, and node-pty's macOS
     * `spawn-helper`, are not addons and would stay sealed in. The failure is
     * silent at package time and shows up as an app that starts and then
     * cannot reach loop at all.
     */
    asar: { unpack: "{**/*.node,**/spawn-helper,**/dist/bin/*}" },
    // Staging already contains exactly what ships; pruning would try to resolve
    // the workspace dependency that was deliberately left out of the manifest.
    prune: false,
    quiet: true,
});
if (!appPath) throw new Error("packager produced no output");
console.log(`  packaged ${appPath}`);

// ─── archive ──────────────────────────────────────────────────────────────
/**
 * zip on macOS/Windows, tar.gz on linux — matching what each platform's users
 * and the install scripts expect. `ditto` on macOS rather than `zip` because it
 * preserves the symlinks and extended attributes inside a .app bundle; a plain
 * `zip -r` produces a bundle that will not launch.
 */
const archiveBase = `loop-desktop-${platform}-${arch}`;
const entries = await readdir(appPath);
const archive = join(out, platform === "linux" ? `${archiveBase}.tar.gz` : `${archiveBase}.zip`);
await rm(archive, { force: true });

if (platform === "darwin") {
    const app = entries.find((e) => e.endsWith(".app"));
    if (!app) throw new Error(`no .app bundle in ${appPath}`);
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", join(appPath, app), archive]);
} else if (platform === "win32") {
    /**
     * Whatever this host actually has.
     *
     * A win32 package is built on a Windows runner in CI but is perfectly
     * cross-buildable from a Mac, and neither host reliably has the other's
     * archiver: `zip` is absent on a stock Windows runner, `powershell` on
     * macOS. Trying both beats picking one and failing in the other place.
     */
    if (process.platform === "win32") {
        await run("powershell", [
            "-NoProfile",
            "-Command",
            `Compress-Archive -Path '${appPath}\\*' -DestinationPath '${archive}' -Force`,
        ]);
    } else {
        await run("zip", ["-r", "-q", archive, "."], appPath);
    }
} else {
    await run("tar", ["-czf", archive, "-C", appPath, "."]);
}

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
    const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${cmd} exited ${code}`);
}

const size = (await Bun.file(archive).size) / 1_000_000;
console.log(`✓ ${archive} (${size.toFixed(1)} MB)`);
