import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { brandEnv } from "../../brand";

/**
 * Find an executable the way a shell would: an explicit override first
 * (LOOP_<NAME>_BIN), then every PATH entry, then the install locations the
 * vendors' own installers use — loop is often launched from a GUI (desktop
 * app, Finder) whose PATH lacks ~/.local/bin and Homebrew.
 */
export function findExecutable(names: readonly string[], overrideEnv: string): string | undefined {
    const override = brandEnv(overrideEnv)?.trim();
    if (override) return isExecutable(override) ? override : undefined;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const dirs = [
        ...(process.env.PATH ?? "").split(delimiter),
        join(home, ".local", "bin"),
        join(home, ".claude", "local"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ].filter(Boolean);
    const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    for (const dir of dirs) {
        for (const name of names) {
            for (const ext of exts) {
                const candidate = join(dir, name + ext);
                if (isExecutable(candidate)) return candidate;
            }
        }
    }
    return undefined;
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Run a short-lived command and collect its output. Never throws. */
export function runCommand(
    bin: string,
    args: readonly string[],
    opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        execFile(
            bin,
            [...args],
            { timeout: opts.timeoutMs ?? 15_000, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, env: process.env },
            (err, stdout, stderr) => {
                const code = err ? ((err as { code?: unknown }).code as number | null) ?? 1 : 0;
                resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) });
            },
        );
    });
}

/**
 * Spawn a CLI that prints one JSON object per line on stdout. Lines that are
 * not JSON (banners, warnings) are skipped. Aborting the signal terminates the
 * process (SIGTERM, then SIGKILL after a grace period) and ends the iterator.
 */
export async function* spawnJsonLines(
    bin: string,
    args: readonly string[],
    opts: {
        cwd?: string;
        stdin?: string;
        signal?: AbortSignal;
        onExit?: (code: number | null, stderr: string) => void;
        /** Handed the child's exit — resolves once the process is really gone. */
        onSpawn?: (exited: Promise<void>) => void;
    },
): AsyncGenerator<Record<string, unknown>> {
    const child: ChildProcess = spawn(bin, [...args], {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
        // Keep only the tail — a chatty CLI must not grow memory unbounded.
        stderr = (stderr + d).slice(-8_000);
    });

    const kill = () => {
        if (child.exitCode !== null || child.killed) return;
        child.kill("SIGTERM");
        setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
        }, 2_000).unref?.();
    };
    if (opts.signal?.aborted) kill();
    opts.signal?.addEventListener("abort", kill, { once: true });

    const exited = new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
        child.on("error", (err) => {
            stderr += `\n${err.message}`;
            resolve(1);
        });
    });

    opts.onSpawn?.(exited.then(() => {}));
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.stdin ?? "");

    try {
        let buf = "";
        child.stdout?.setEncoding("utf8");
        for await (const chunk of child.stdout as AsyncIterable<string>) {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                const parsed = parseJsonLine(line);
                if (parsed) yield parsed;
            }
        }
        const last = parseJsonLine(buf.trim());
        if (last) yield last;
        opts.onExit?.(await exited, stderr);
    } finally {
        opts.signal?.removeEventListener("abort", kill);
        // The consumer stopped early (abort, error): don't leave the agent running.
        kill();
    }
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
    if (!line.startsWith("{")) return undefined;
    try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}
