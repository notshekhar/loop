/**
 * One OAuth refresh at a time, across every process sharing ~/.loop.
 *
 * Providers that rotate refresh tokens (xAI, Anthropic, ChatGPT) accept each
 * refresh token exactly once, and treat a second use as theft: the whole grant
 * is revoked and every client has to sign in again. Several processes share
 * one auth.json — the desktop app, `loop rpc`, every terminal, pi — so two of
 * them noticing the same expired token and refreshing in parallel is not a
 * corner case, it is what happens every hour.
 *
 * The lock is a directory (mkdir is atomic on every filesystem we run on). A
 * holder that died leaves it behind, so one older than STALE_MS is broken.
 * pi takes the same lock at the same path, which is what lets the two share a
 * login.
 */
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../brand";

const STALE_MS = 60_000;
const WAIT_MS = 30_000;
const POLL_MS = 100;

function lockPath(): string {
    return join(getConfigDir(), "auth.json.lock");
}

function tryAcquire(path: string): boolean {
    try {
        mkdirSync(path, { recursive: false });
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            mkdirSync(getConfigDir(), { recursive: true });
            return tryAcquire(path);
        }
        try {
            if (Date.now() - statSync(path).mtimeMs > STALE_MS) {
                rmSync(path, { recursive: true, force: true });
                return tryAcquire(path);
            }
        } catch {
            // Released between our mkdir and stat: try again on the next poll.
        }
        return false;
    }
}

/**
 * Run `fn` holding the cross-process auth lock. If the lock cannot be had
 * within WAIT_MS the function runs anyway — a stuck lock must never become an
 * outage; the caller re-reads auth.json first, which covers the common case.
 */
export async function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
    const path = lockPath();
    const deadline = Date.now() + WAIT_MS;
    let held = tryAcquire(path);
    while (!held && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        held = tryAcquire(path);
    }
    try {
        return await fn();
    } finally {
        if (held) rmSync(path, { recursive: true, force: true });
    }
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Collapse concurrent refreshes of the same credential inside this process
 * into one: parallel requests (subagents, the catalog probe, a turn) that all
 * see the token expire share a single refresh instead of each spending the
 * refresh token.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const started = fn().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
}
