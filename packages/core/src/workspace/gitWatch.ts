/**
 * Tell the status panel when a repository changed, instead of having it ask.
 *
 * The panel used to re-read git every five seconds, and one read is eight or
 * nine `git` processes (status, numstat per side, ls-files, rev-list, …) — a
 * hundred spawns a minute per open project, each waking the CPU, all day, to
 * learn mostly that nothing happened. This watches instead, the way editors
 * do: the working tree for edits, and git's own bookkeeping (`index`, `HEAD`,
 * `refs/`, `packed-refs`, `FETCH_HEAD`) for staging, commits, checkouts,
 * fetches and pushes made anywhere — the panel, the terminal, an agent.
 *
 * On macOS and Windows a recursive `fs.watch` is one FSEvents /
 * ReadDirectoryChangesW handle for the whole tree, so this costs nearly
 * nothing at rest. Git's own reads never trigger it: every read runs with
 * `GIT_OPTIONAL_LOCKS=0` (see git.ts), so `git status` does not rewrite the
 * index and wake its own watcher.
 *
 * Bursts are coalesced: an `npm install` or a branch switch touches thousands
 * of files, and the panel needs one refresh once it settles — or one every
 * couple of seconds while it does not.
 *
 * Watches are LEASED. A client renews every minute and a watch nobody renewed
 * for a few minutes is closed, so a browser tab that vanished without saying
 * goodbye (serve has no per-client teardown for workspace calls) cannot leave
 * a watcher behind.
 */
import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { readGit } from "./git";

/** Quiet time after the last event before telling anyone. */
export const GIT_WATCH_DEBOUNCE_MS = 300;
/** Longest a continuous burst can hold a refresh back. */
export const GIT_WATCH_MAX_WAIT_MS = 2_000;
/** A watch not renewed within this long is closed. Clients renew every minute. */
export const GIT_WATCH_LEASE_MS = 3 * 60_000;

/** Files inside a git directory whose change means the status changed. */
const GIT_STATE_FILES = new Set([
    "index",
    "HEAD",
    "packed-refs",
    "FETCH_HEAD",
    "MERGE_HEAD",
    "ORIG_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
]);

/**
 * Whether a change at `path` (relative to the watched root, either separator)
 * can change what `git status` reports.
 *
 * Inside a `.git` directory only the state files and refs count — objects,
 * logs and lock files churn on every write and say nothing new by themselves
 * (the rename that ends a write lands on `index` or a ref, and that counts).
 * `node_modules` is skipped outright: it is ignored in practice everywhere,
 * and an install would otherwise be thousands of events.
 */
export function isStatusRelevant(path: string | null | undefined): boolean {
    // Some platforms omit the name; a change we cannot place may matter.
    if (!path) return true;
    const parts = path.split(/[\\/]+/).filter(Boolean);
    if (parts.includes("node_modules")) return false;
    const gitAt = parts.lastIndexOf(".git");
    if (gitAt === -1) return true;
    const inside = parts.slice(gitAt + 1);
    if (inside.length === 0) return true; // the `.git` entry itself (a worktree's file, or a fresh init)
    const name = inside[inside.length - 1]!;
    if (name.endsWith(".lock")) return false;
    if (inside[0] === "refs") return true;
    return inside.length === 1 && GIT_STATE_FILES.has(name);
}

/** Same test for a path inside a separately watched git directory. */
function isGitDirRelevant(path: string | null | undefined): boolean {
    return isStatusRelevant(path ? join(".git", path) : null);
}

interface Root {
    readonly cwd: string;
    readonly watchers: FSWatcher[];
    readonly leases: Map<string, number>;
    /** Settles once the watchers are open, for a second watch racing the first. */
    ready: Promise<void>;
    debounce: ReturnType<typeof setTimeout> | null;
    firstEventAt: number | null;
}

export interface GitWatchResult {
    /** False when the platform refused a watch: the client should keep polling. */
    readonly native: boolean;
}

export interface GitWatcherOptions {
    /** Called once per settled burst of changes in `cwd`. */
    readonly onChange: (cwd: string) => void;
    /** Tests: a clock and watcher factory of their own. */
    readonly now?: () => number;
    readonly watchFactory?: typeof watch;
}

export class GitWatchers {
    readonly #roots = new Map<string, Root>();
    readonly #onChange: (cwd: string) => void;
    readonly #now: () => number;
    readonly #watch: typeof watch;
    #sweeper: ReturnType<typeof setInterval> | null = null;

    constructor(options: GitWatcherOptions) {
        this.#onChange = options.onChange;
        this.#now = options.now ?? Date.now;
        this.#watch = options.watchFactory ?? watch;
    }

    /** Start (or renew) the watch `id` holds on `cwd`. */
    async watch(cwd: string, id: string): Promise<GitWatchResult> {
        const key = resolve(cwd);
        const existing = this.#roots.get(key);
        if (existing) {
            existing.leases.set(id, this.#now() + GIT_WATCH_LEASE_MS);
            await existing.ready;
            return { native: existing.watchers.length > 0 };
        }
        const root: Root = {
            cwd,
            watchers: [],
            leases: new Map(),
            ready: Promise.resolve(),
            debounce: null,
            firstEventAt: null,
        };
        root.leases.set(id, this.#now() + GIT_WATCH_LEASE_MS);
        this.#roots.set(key, root);
        root.ready = this.#open(root, key);
        await root.ready;
        // Released while we were resolving the git directory.
        if (this.#roots.get(key) !== root) {
            for (const watcher of root.watchers) watcher.close();
            return { native: false };
        }
        this.#armSweeper();
        return { native: root.watchers.length > 0 };
    }

    /** Drop the watch `id` holds; the root closes when nobody holds it. */
    unwatch(id: string): void {
        for (const [key, root] of this.#roots) {
            if (root.leases.delete(id) && root.leases.size === 0) this.#close(key, root);
        }
    }

    /** Close every expired watch. Runs on a timer; public for tests. */
    sweep(): void {
        const now = this.#now();
        for (const [key, root] of this.#roots) {
            for (const [id, expires] of root.leases) if (expires <= now) root.leases.delete(id);
            if (root.leases.size === 0) this.#close(key, root);
        }
        if (this.#roots.size === 0 && this.#sweeper) {
            clearInterval(this.#sweeper);
            this.#sweeper = null;
        }
    }

    /** How many folders are watched (diagnostics, tests). */
    get size(): number {
        return this.#roots.size;
    }

    closeAll(): void {
        for (const [key, root] of this.#roots) this.#close(key, root);
        if (this.#sweeper) clearInterval(this.#sweeper);
        this.#sweeper = null;
    }

    async #open(root: Root, key: string): Promise<void> {
        const add = (path: string, relevant: (name: string | null) => boolean) => {
            try {
                const watcher = this.#watch(path, { recursive: true, persistent: false }, (_event, name) => {
                    if (relevant(typeof name === "string" ? name : null)) this.#changed(root);
                });
                // A watched folder deleted or unmounted: stop quietly; the
                // client's slow fallback poll still covers it.
                watcher.on("error", () => watcher.close());
                root.watchers.push(watcher);
            } catch {
                // ENOSPC (inotify limit), EPERM, a missing folder: the client polls.
            }
        };
        add(key, isStatusRelevant);

        // A linked worktree or a submodule keeps its git directory outside the
        // tree (`.git` is a file pointing at it), so the index and refs that
        // change on a commit or a checkout are not under `key` — watch those too.
        const dirs = await readGit(key, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
        const [gitDir, commonRaw] = (dirs ?? "").split("\n").map((line) => line.trim());
        const common = commonRaw ? (isAbsolute(commonRaw) ? commonRaw : resolve(key, commonRaw)) : "";
        for (const dir of new Set([gitDir, common].filter(Boolean) as string[])) {
            const rel = relative(key, dir);
            const outside = rel.startsWith("..") || isAbsolute(rel);
            if (outside || rel.split(sep).includes("..")) add(dir, isGitDirRelevant);
        }
    }

    #changed(root: Root): void {
        const now = this.#now();
        root.firstEventAt ??= now;
        if (root.debounce) clearTimeout(root.debounce);
        const waited = now - root.firstEventAt;
        const delay = Math.max(0, Math.min(GIT_WATCH_DEBOUNCE_MS, GIT_WATCH_MAX_WAIT_MS - waited));
        root.debounce = setTimeout(() => {
            root.debounce = null;
            root.firstEventAt = null;
            this.#onChange(root.cwd);
        }, delay);
        (root.debounce as { unref?: () => void }).unref?.();
    }

    #close(key: string, root: Root): void {
        if (root.debounce) clearTimeout(root.debounce);
        for (const watcher of root.watchers) watcher.close();
        this.#roots.delete(key);
    }

    #armSweeper(): void {
        if (this.#sweeper) return;
        this.#sweeper = setInterval(() => this.sweep(), 30_000);
        (this.#sweeper as { unref?: () => void }).unref?.();
    }
}
