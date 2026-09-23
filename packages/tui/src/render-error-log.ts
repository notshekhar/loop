/**
 * loop-local (keep across pi-mono syncs): the record a failed frame leaves.
 *
 * A frame that throws paints nothing, so the screen simply stops changing —
 * and for a long time nothing was written anywhere either, which made "the
 * TUI froze" a report with no evidence behind it. This is where the evidence
 * goes: one entry per DISTINCT failure, with its stack, appended to
 * `render-error.log` in the agent directory.
 *
 * Two rules keep it from becoming a failure source of its own:
 *   - it never throws — a logger that can fail inside an error path turns one
 *     broken frame into a crash;
 *   - repeats are dropped — a render that fails once usually fails on every
 *     frame after, and an entry per frame is sixty lines a second of the same
 *     stack.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { brandEnv, CONFIG_DIR_NAME } from "./brand";

const seen = new Set<string>();

/** A stable key for "the same failure": where it happened, and what it said. */
function failureKey(where: string, error: unknown): string {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return `${where}\u0000${message}`;
}

/** Where the TUI keeps its logs unless told otherwise — the agent directory. */
function agentDirectory(): string {
    return brandEnv("AGENT_DIR") ?? path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}

/**
 * Record a render failure once. Returns true the FIRST time a given failure
 * is seen, so a caller can surface it once and stay quiet after.
 */
export function logRenderError(where: string, error: unknown, directory: string = agentDirectory()): boolean {
    const key = failureKey(where, error);
    if (seen.has(key)) return false;
    seen.add(key);
    try {
        const stack = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
        fs.mkdirSync(directory, { recursive: true });
        fs.appendFileSync(
            path.join(directory, "render-error.log"),
            `[${new Date().toISOString()}] ${where}\n${stack}\n\n`,
        );
    } catch {
        // The log is evidence, not a dependency: losing it must cost nothing.
    }
    return true;
}

/** Forget what has been logged (tests). */
export function resetRenderErrorLogForTest(): void {
    seen.clear();
}
