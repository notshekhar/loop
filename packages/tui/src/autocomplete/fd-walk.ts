import { spawn } from "child_process";
import { toDisplayPath } from "./path-token";

/** One path fd found, relative to the walked directory; directories end in `/`. */
export interface FdEntry {
    path: string;
    isDirectory: boolean;
}

/** fd stops after this many hits per walk; ranking then keeps the best of them. */
export const FD_MAX_RESULTS = 100;

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
    const normalized = toDisplayPath(query);
    if (!normalized.includes("/")) {
        return normalized;
    }

    const hasTrailingSeparator = normalized.endsWith("/");
    const trimmed = normalized.replace(/^\/+|\/+$/g, "");
    if (!trimmed) {
        return normalized;
    }

    const separatorPattern = "[\\\\/]";
    const segments = trimmed
        .split("/")
        .filter(Boolean)
        .map((segment) => escapeRegex(segment));
    if (segments.length === 0) {
        return normalized;
    }

    let pattern = segments.join(separatorPattern);
    if (hasTrailingSeparator) {
        pattern += separatorPattern;
    }
    return pattern;
}

function buildFdArgs(baseDir: string, query: string, maxResults: number, maxDepth?: number): string[] {
    const args = [
        "--base-directory",
        baseDir,
        "--max-results",
        String(maxResults),
        "--type",
        "f",
        "--type",
        "d",
        "--follow",
        "--hidden",
        "--exclude",
        ".git",
        "--exclude",
        ".git/*",
        "--exclude",
        ".git/**",
    ];

    if (maxDepth !== undefined) {
        args.push("--max-depth", String(maxDepth));
    }

    if (toDisplayPath(query).includes("/")) {
        args.push("--full-path");
    }

    if (query) {
        args.push(buildFdPathQuery(query));
    }
    return args;
}

function isInsideGitDir(path: string): boolean {
    return path === ".git" || path.startsWith(".git/") || path.includes("/.git/");
}

function parseFdOutput(stdout: string): FdEntry[] {
    const results: FdEntry[] = [];
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const displayLine = toDisplayPath(line);
        const hasTrailingSeparator = displayLine.endsWith("/");
        const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
        if (isInsideGitDir(normalizedPath)) {
            continue;
        }
        results.push({ path: displayLine, isDirectory: hasTrailingSeparator });
    }
    return results;
}

/** Run fd and collect its stdout; resolves "" on any failure or abort. */
function runFd(fdPath: string, args: string[], signal: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve("");
            return;
        }

        const child = spawn(fdPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let resolved = false;

        const finish = (output: string) => {
            if (resolved) return;
            resolved = true;
            signal.removeEventListener("abort", onAbort);
            resolve(output);
        };

        const onAbort = () => {
            if (child.exitCode === null) {
                child.kill("SIGKILL");
            }
        };

        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.on("error", () => {
            finish("");
        });
        child.on("close", (code) => {
            finish(signal.aborted || code !== 0 ? "" : stdout);
        });
    });
}

// Use fd to walk directory tree (fast, respects .gitignore)
export async function walkDirectoryWithFd(
    baseDir: string,
    fdPath: string,
    query: string,
    maxResults: number,
    signal: AbortSignal,
    maxDepth?: number,
): Promise<FdEntry[]> {
    const stdout = await runFd(fdPath, buildFdArgs(baseDir, query, maxResults, maxDepth), signal);
    return stdout ? parseFdOutput(stdout) : [];
}
