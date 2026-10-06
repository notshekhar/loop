#!/usr/bin/env bun
// Standalone binary build via `bun build --compile`.
// Bundles ALL deps (no externals) for the current platform.
//
// Output: dist/bin/<target>/ containing `loop` (or `loop.exe`) and `package.json`,
// plus dist/bin/loop-<target>.tar.gz tarball ready to upload to GH Releases.

import { readFileSync, mkdirSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { webAppPackPlugin } from "../core/build-web-app";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { version: string };
// Embedded so the standalone binary can serve /changelog without a file on disk.
const changelog = readFileSync(join(import.meta.dir, "CHANGELOG.md"), "utf8");

const VALID_TARGETS = new Set([
    "bun-darwin-arm64",
    "bun-darwin-x64",
    "bun-linux-x64",
    "bun-linux-arm64",
    "bun-windows-x64",
]);

function currentTarget(): string {
    const platform = process.platform;
    const arch = process.arch;
    const os =
        platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
    if (!os) throw new Error(`Unsupported platform: ${platform}`);
    const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
    if (!a) throw new Error(`Unsupported arch: ${arch}`);
    return `bun-${os}-${a}`;
}

const argTarget = process.argv[2];
const target = argTarget ?? currentTarget();
if (!VALID_TARGETS.has(target)) {
    console.error(`Invalid target: ${target}. Valid: ${[...VALID_TARGETS].join(", ")}`);
    process.exit(1);
}

const shortTarget = target.replace("bun-", "");
const isWin = target.includes("windows");
const ext = isWin ? ".exe" : "";

// Maximize CPU compatibility. By default `bun --compile` emits a "modern"
// (Haswell/AVX2) x64 build that crashes with SIGILL on pre-2013 / low-end CPUs
// (older servers, budget VPSes, VMs). Compile the `-baseline` (Nehalem) variant
// for x64 so the published binaries run on ALL x64 CPUs. arm64 has no
// baseline/modern split.
//
// Windows is excluded: Bun's `bun-windows-x64-baseline` runtime currently fails
// to extract ("download may be incomplete", repro on Bun 1.3.14), so Windows
// ships the default build (Win11 needs a modern CPU anyway). The native Windows
// CI runner's own Bun is already bun-windows-x64, so the plain target needs no
// extra runtime download. Revisit when Bun fixes baseline-windows packaging.
//
// The published asset name keeps the plain arch (loop-linux-x64.tar.gz) — only
// the bun build target gains the suffix, so Homebrew + installers are unaffected.
const useBaseline = shortTarget.endsWith("x64") && !isWin;
const compileTarget = useBaseline ? `${target}-baseline` : target;

const stageDir = join(import.meta.dir, "dist", "bin", shortTarget);
const binPath = join(stageDir, `loop${ext}`);
const pkgJsonPath = join(stageDir, "package.json");

if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
mkdirSync(stageDir, { recursive: true });

console.log(`▶ building ${binPath} (v${pkg.version}) [target ${compileTarget}]`);

// serve's UI (apps/web), embedded in the binary; read only when serve starts.
const webApp = await webAppPackPlugin("compile", join(import.meta.dir, "dist", "web-app"));

// Use the Bun.build API rather than shelling out to `bun build --compile`: the
// embedded CHANGELOG is passed as an in-process `define`, not a command-line
// argument. As a CLI arg it grows the command line past Windows' ~32 KB
// CreateProcess limit once the changelog gets large, which surfaced as a
// "File name too long" Windows build failure. In-process defines have no such
// limit, so this builds identically on every platform.
const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/cli.ts")],
    compile: { target: compileTarget as Bun.Build.CompileTarget, outfile: binPath },
    minify: true,
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
        __APP_CHANGELOG__: JSON.stringify(changelog),
    },
    plugins: [webApp],
});
if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}

// ── Re-sign the macOS binaries (ad-hoc) ───────────────────────────────────
// `bun build --compile` leaves a Mach-O whose ad-hoc signature does NOT match
// the file it is attached to — `codesign -v` on a freshly built binary says
// "code or signature have been modified", because the JS payload is appended
// after the CodeDirectory was computed. Whether that is fatal is up to the
// machine: most Macs only hash the pages they map and never notice, but on a
// machine that does check, the kernel SIGKILLs it on exec and the shell prints
// a bare `killed` with no output at all — which is exactly what the installer's
// own smoke test hit on a user's Mac after 0.19.13 → 0.19.14.
//
// Re-signing ad-hoc rewrites the signature over the real bytes, so the binary
// verifies and runs everywhere. Only meaningful on darwin targets, and only
// possible on a macOS host (codesign ships with the OS) — the CI matrix builds
// both darwin targets on macos-14, so both get signed. Anywhere else this is a
// warning, not a failure: an unsigned build is what we shipped until now.
if (shortTarget.startsWith("darwin")) {
    if (process.platform !== "darwin") {
        console.warn(`⚠ ${shortTarget} built on ${process.platform}: cannot codesign — signature will be invalid`);
    } else {
        console.log(`▶ codesign --sign - ${binPath}`);
        // --force replaces bun's stale ad-hoc signature rather than refusing.
        await $`codesign --force --sign - ${binPath}`.quiet();
        // Verify rather than trust: a signature that doesn't check out here is
        // the bug this step exists to prevent, and it must not reach a release.
        await $`codesign --verify --strict ${binPath}`.quiet();
        console.log(`  signature verified`);
    }
}

// Ship package.json alongside the binary — version metadata for installers.
copyFileSync(join(import.meta.dir, "package.json"), pkgJsonPath);

// Tarball for release. Windows users still get .tar.gz; install.sh expands it.
// chdir + relative paths so neither GNU tar (D:\... → tries host:path) nor
// bsdtar (no --force-local flag) trip on Windows absolute paths.
const tarball = join(import.meta.dir, "dist", "bin", `loop-${shortTarget}.tar.gz`);
const binDir = join(import.meta.dir, "dist", "bin");
const tarballRel = `loop-${shortTarget}.tar.gz`;
if (existsSync(tarball)) rmSync(tarball);
await $`tar -czf ${tarballRel} ${shortTarget}`.cwd(binDir);

console.log(`built ${binPath}`);
console.log(`packaged ${tarball}`);
