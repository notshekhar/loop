/**
 * Auto-installs npm-based language servers into ~/.loop/servers/<key>/ on first
 * use, so diagnostics work without the user pre-installing anything. The install
 * runs with loop's own runtime as the package manager: the loop binary, which
 * BUN_BE_BUN=1 makes behave as the bun CLI — so `install` works with no
 * separate node/bun on the machine. See bun-binary.ts for which binary that is.
 */
import { getConfigDir } from "../../../brand";
import { bunBinary } from "../../../bun-binary";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVERS_DIR = join(getConfigDir(), "servers");
const GO_BIN_DIR = join(SERVERS_DIR, "bin");
const INSTALL_TIMEOUT_MS = 90_000;
const GO_INSTALL_TIMEOUT_MS = 180_000;

/** Where a provisioned server landed: its install dir and its bin path. */
export interface Provisioned {
    dir: string;
    bin: string;
}

const inFlight = new Map<string, Promise<Provisioned | null>>();

/**
 * Whether the dir was installed from exactly these dependencies. Without this
 * check an existing binary satisfies the lookup forever, so a registry that
 * switches servers or bumps a version (typescript-language-server + TS6 →
 * TypeScript 7) keeps launching the old one after a loop upgrade.
 */
function matchesRequested(dir: string, npm: Record<string, string>): boolean {
    try {
        const raw = readFileSync(join(dir, "package.json"), "utf-8");
        const deps = (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {};
        const want = Object.keys(npm);
        if (want.length !== Object.keys(deps).length) return false;
        return want.every((name) => deps[name] === npm[name]);
    } catch {
        return false;
    }
}

export function ensureProvisioned(
    key: string,
    npm: Record<string, string>,
    npmBin: string,
): Promise<Provisioned | null> {
    const dir = join(SERVERS_DIR, key);
    const binPath = join(dir, npmBin);
    if (existsSync(binPath) && matchesRequested(dir, npm)) return Promise.resolve({ dir, bin: binPath });

    const existing = inFlight.get(key);
    if (existing) return existing;

    const job = install(dir, npm, binPath).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
}

async function install(dir: string, npm: Record<string, string>, binPath: string): Promise<Provisioned | null> {
    try {
        // Drop a previous install whose dependencies no longer match, so stale
        // node_modules from an older registry can't shadow the new server.
        if (existsSync(dir) && !matchesRequested(dir, npm)) {
            rmSync(join(dir, "node_modules"), { recursive: true, force: true });
            rmSync(join(dir, "bun.lock"), { force: true });
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({ name: "loop-lsp-server", private: true, dependencies: npm }, null, 2),
        );
        const bun = bunBinary();
        if (bun === null) return null;
        const ok = await run(bun, ["install"], dir, INSTALL_TIMEOUT_MS);
        return ok && existsSync(binPath) ? { dir, bin: binPath } : null;
    } catch {
        return null;
    }
}

const goInFlight = new Map<string, Promise<string | null>>();

/**
 * `go install <pkg>` into ~/.loop/servers/bin. Only reached when the binary
 * isn't already on PATH and the registry entry declares `requires: ["go"]`, so
 * this never runs on a machine without a Go toolchain.
 */
export function ensureGoInstalled(binName: string, pkg: string): Promise<string | null> {
    const exe = join(GO_BIN_DIR, binName + (process.platform === "win32" ? ".exe" : ""));
    if (existsSync(exe)) return Promise.resolve(exe);

    const existing = goInFlight.get(pkg);
    if (existing) return existing;

    const job = (async () => {
        try {
            mkdirSync(GO_BIN_DIR, { recursive: true });
            const ok = await run("go", ["install", pkg], SERVERS_DIR, GO_INSTALL_TIMEOUT_MS, { GOBIN: GO_BIN_DIR });
            return ok && existsSync(exe) ? exe : null;
        } catch {
            return null;
        }
    })().finally(() => goInFlight.delete(pkg));
    goInFlight.set(pkg, job);
    return job;
}

function run(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    env: Record<string, string> = { BUN_BE_BUN: "1" },
): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(command, args, {
            cwd,
            stdio: "ignore",
            env: { ...process.env, ...env },
        });
        const timer = setTimeout(() => {
            proc.kill();
            resolve(false);
        }, timeoutMs);
        proc.on("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
        proc.on("exit", (code) => {
            clearTimeout(timer);
            resolve(code === 0);
        });
    });
}
