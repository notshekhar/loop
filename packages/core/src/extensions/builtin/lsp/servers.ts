/**
 * Turns a registry entry into a runnable LspServerSpec: detect a
 * project-local/PATH server first (uses the project's own toolchain), else
 * provision one into ~/.loop/servers. Everything is driven by the registry.
 */
import { brandEnv } from "../../../brand";
import { bunBinary } from "../../../bun-binary";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { LspServerSpec } from "./client";
import { ensureDownloaded, javaConfigDir, javaDataDir } from "./download";
import { ensureGoInstalled, ensureProvisioned } from "./provision";
import {
    defHandles,
    findDef,
    getServerDefs,
    type LanguageKey,
    type LanguageServerDef,
    languageIdFor,
} from "./registry";

export { defHandles, type LanguageKey, languageKeyFor, languageKeysFor, getServerDefs, findDef } from "./registry";

function onPath(name: string): string | null {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "pipe" });
    return probe.status === 0 ? name : null;
}

/** `<bin> --version` → major version number, or null if it can't be read. */
const versionCache = new Map<string, number | null>();
function majorVersion(bin: string): number | null {
    const cached = versionCache.get(bin);
    if (cached !== undefined) return cached;
    let major: number | null = null;
    try {
        const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
        const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
        // "Version 5.9.3", "tsc 7.0.2", "gopls v0.16.1" — first number wins.
        const m = /(\d+)\.\d+/.exec(text);
        if (m) major = Number(m[1]);
    } catch {
        major = null;
    }
    versionCache.set(bin, major);
    return major;
}

/**
 * A candidate is only usable if it's new enough to speak LSP. An unreadable
 * version is treated as unusable when a minimum is declared: launching a binary
 * that doesn't understand `--lsp` costs a failed handshake and takes the whole
 * language down with it, which is worse than falling through to provisioning.
 */
function usable(bin: string, def: LanguageServerDef): boolean {
    if (def.minMajorVersion === undefined) return true;
    const major = majorVersion(bin);
    return major !== null && major >= def.minMajorVersion;
}

function resolveBinary(rootPath: string, def: LanguageServerDef): string | null {
    const isWin = process.platform === "win32";
    for (const name of def.binNames) {
        const local = join(rootPath, "node_modules", ".bin", isWin ? `${name}.cmd` : name);
        if (existsSync(local) && usable(local, def)) return local;
    }
    for (const name of def.binNames) {
        if (onPath(name) && usable(name, def)) return name;
    }
    return null;
}

/**
 * Every requirement satisfied? A server whose toolchain is missing can't run —
 * and, for the ones with a download route, this is also what stops us pulling
 * 50MB onto a machine that could never launch it. Checked before any network.
 */
function requirementsMet(def: LanguageServerDef): boolean {
    for (const bin of def.requires ?? []) {
        if (onPath(bin) === null) return false;
        const min = def.requiresMinVersion?.[bin];
        // An unreadable version fails closed, exactly as it does for the server
        // binary itself: a wrong guess costs a failed handshake and takes the
        // whole language down, which is worse than reporting no server.
        if (min !== undefined && (majorVersion(bin) ?? 0) < min) return false;
    }
    return true;
}

/**
 * The directory a server should treat as its project root: the nearest ancestor
 * of the file holding one of the server's root markers, else the workspace. A
 * monorepo with three tsconfigs gets three servers, each scoped to its package,
 * which is what makes the diagnostics right.
 */
export function findRoot(def: LanguageServerDef, filePath: string, fallback: string): string {
    const markers = def.rootMarkers ?? [];
    if (markers.length === 0) return fallback;
    const stopAt = parse(filePath).root;
    let dir = dirname(filePath);
    for (;;) {
        for (const marker of markers) {
            if (existsSync(join(dir, marker))) return dir;
        }
        if (dir === stopAt || dir === fallback) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return fallback;
}

/**
 * A marker that stands this server down — a Deno project must not also be
 * served by the TypeScript server, which would double every diagnostic.
 */
export function isDisqualified(def: LanguageServerDef, filePath: string, fallback: string): boolean {
    const markers = def.disqualifyMarkers ?? [];
    if (markers.length === 0) return false;
    const root = findRoot(def, filePath, fallback);
    return markers.some((m) => existsSync(join(root, m)));
}

/**
 * Build a launch spec. "node" servers (e.g. pyright-langserver) run with loop's
 * runtime: the loop binary, which BUN_BE_BUN=1 makes behave as the bun CLI — so
 * no separate node/bun is needed; without one (bun-binary.ts) they cannot run.
 * "native" servers (e.g. gopls, TypeScript 7's tsc) run directly.
 */
function specFromExe(def: LanguageServerDef, exe: string, forceNative = false): LspServerSpec | null {
    const languageId = (absPath: string) => languageIdFor(def, absPath);
    const args = def.args ?? [];
    if (def.runtime === "node" && !forceNative) {
        const bun = bunBinary();
        if (bun === null) return null;
        return { name: def.key, command: bun, args: [exe, ...args], env: { BUN_BE_BUN: "1" }, languageId };
    }
    return { name: def.key, command: exe, args: [...args], languageId };
}

/**
 * A jar is not an executable: `runtime: "java"` servers are launched by the
 * user's own JVM, with the JVM flags ahead of `-jar` where the JVM will read
 * them, and the templated paths resolved against the unpacked archive.
 *
 * Only reached for a DOWNLOADED server. A `jdtls` found on PATH is a launcher
 * script that already does all of this, so it is run directly.
 */
export function specFromJar(def: LanguageServerDef, jar: string, dir: string): LspServerSpec | null {
    const configDir = javaConfigDir(dir);
    if (!configDir) return null;
    const vars: Record<string, string> = { configDir, dataDir: javaDataDir(), dir, jar };
    const args = (def.args ?? []).map((a) => a.replace(/\{(\w+)\}/g, (whole, n: string) => vars[n] ?? whole));
    return {
        name: def.key,
        command: "java",
        args: [...(def.jvmArgs ?? []), "-jar", jar, ...args],
        languageId: (absPath: string) => languageIdFor(def, absPath),
    };
}

/** `{platform}`/`{arch}` → this machine, for npmNativeBin. */
function expandNativePath(template: string): string {
    return template.replace("{platform}", process.platform).replace("{arch}", process.arch);
}

export function resolveServer(key: LanguageKey, rootPath: string): LspServerSpec | null {
    const def = findDef(key);
    if (!def || !requirementsMet(def)) return null;
    const exe = resolveBinary(rootPath, def);
    // A binary found on PATH is always run directly: for a "java" server that
    // binary is the distribution's own launcher script, which builds the JVM
    // command line itself.
    return exe ? specFromExe(def, exe, def.runtime === "java") : null;
}

/**
 * Installing a language server reaches the network and writes to the user's
 * disk. That is the right default — a server the agent can't start is a feature
 * that silently doesn't work — but an airgapped box, a locked-down CI image or
 * anyone who simply wants to manage their own toolchain needs one switch that
 * turns all of it off. Discovery from node_modules/.bin and PATH is unaffected.
 */
export function downloadsDisabled(): boolean {
    const raw = brandEnv("DISABLE_LSP_DOWNLOAD");
    return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
}

export async function resolveOrProvisionServer(key: LanguageKey, rootPath: string): Promise<LspServerSpec | null> {
    const def = findDef(key);
    if (!def || !requirementsMet(def)) return null;

    const local = resolveServer(key, rootPath);
    if (local) return local;
    if (downloadsDisabled()) return null;

    // npm-provisioned: prefer the native per-platform binary when the package
    // ships one (TypeScript 7), since the JS bin is only a shim over it.
    if (def.npm && def.npmBin) {
        const installed = await ensureProvisioned(key, def.npm, def.npmBin);
        if (installed) {
            if (def.npmNativeBin) {
                const native = join(installed.dir, expandNativePath(def.npmNativeBin));
                if (existsSync(native)) return specFromExe(def, native, true);
            }
            return specFromExe(def, installed.bin);
        }
    }

    if (def.goInstall) {
        const installed = await ensureGoInstalled(def.binNames[0], def.goInstall);
        if (installed) return specFromExe(def, installed, true);
    }

    // Last route: a prebuilt release archive for this machine. Cheapest to
    // check on a repeat run (a marker file, no network) and the only one that
    // can decline before opening a socket, so it goes after the others.
    if (def.download) {
        const installed = await ensureDownloaded(key, def.download);
        if (installed) {
            return def.runtime === "java"
                ? specFromJar(def, installed.bin, installed.dir)
                : specFromExe(def, installed.bin, true);
        }
    }

    return null;
}

/** Which servers could serve this file, after disqualification. */
export function serversFor(filePath: string, fallbackRoot: string): LanguageServerDef[] {
    return getServerDefs().filter(
        (def) => defHandles(def, filePath) && !isDisqualified(def, filePath, fallbackRoot) && requirementsMet(def),
    );
}
