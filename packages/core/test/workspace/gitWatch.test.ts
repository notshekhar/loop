/**
 * The status panel is told when a repository changes instead of polling it:
 * an edit, a stage, a commit or a branch switch fires one notification per
 * settled burst; git's own churn (objects, locks) and node_modules do not;
 * and a watch nobody renews is closed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GIT_WATCH_LEASE_MS, GitWatchers, isStatusRelevant } from "../../src/workspace/gitWatch";

describe("which changes matter", () => {
    test("the working tree and git's state files", () => {
        expect(isStatusRelevant("src/app.ts")).toBe(true);
        expect(isStatusRelevant(".git/index")).toBe(true);
        expect(isStatusRelevant(".git/HEAD")).toBe(true);
        expect(isStatusRelevant(".git/refs/heads/main")).toBe(true);
        expect(isStatusRelevant(".git/packed-refs")).toBe(true);
        expect(isStatusRelevant(".git/FETCH_HEAD")).toBe(true);
        // A nested repository in a workspace folder.
        expect(isStatusRelevant("api/.git/index")).toBe(true);
        expect(isStatusRelevant(null)).toBe(true);
    });

    test("not git's own churn, and not node_modules", () => {
        expect(isStatusRelevant(".git/objects/ab/cdef")).toBe(false);
        expect(isStatusRelevant(".git/index.lock")).toBe(false);
        expect(isStatusRelevant(".git/logs/HEAD")).toBe(false);
        expect(isStatusRelevant(".git/refs/heads/main.lock")).toBe(false);
        expect(isStatusRelevant("node_modules/react/index.js")).toBe(false);
        expect(isStatusRelevant("packages/web/node_modules/x.js")).toBe(false);
        expect(isStatusRelevant(".git\\index")).toBe(true);
    });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
        },
    });

describe("watching a repository", () => {
    let repo: string;
    let changes: string[];
    let watchers: GitWatchers;

    beforeEach(() => {
        repo = realpathSync(mkdtempSync(join(tmpdir(), "loop-gitwatch-")));
        git(repo, "init", "-q", "-b", "main");
        writeFileSync(join(repo, "a.txt"), "one\n");
        git(repo, "add", ".");
        git(repo, "commit", "-q", "-m", "init");
        changes = [];
        watchers = new GitWatchers({ onChange: (cwd) => changes.push(cwd) });
    });

    afterEach(() => {
        watchers.closeAll();
        rmSync(repo, { recursive: true, force: true });
    });

    /** Wait for a burst to settle: FSEvents latency plus the debounce. */
    const settle = () => sleep(1_200);
    /**
     * Wait until the watcher has been quiet for a while, then forget what it
     * saw: FSEvents can deliver the repository's own setup (init, the first
     * commit) late, especially on a loaded machine.
     */
    const quiet = async () => {
        let seen = -1;
        for (let i = 0; i < 10 && seen !== changes.length; i++) {
            seen = changes.length;
            await sleep(800);
        }
        changes.length = 0;
    };

    test("an edit, a stage and a commit each notify, once per burst", async () => {
        expect(await watchers.watch(repo, "w1")).toEqual({ native: true });
        await quiet();

        for (let i = 0; i < 20; i++) writeFileSync(join(repo, "a.txt"), `edit ${i}\n`);
        await settle();
        expect(changes).toEqual([repo]);

        changes.length = 0;
        git(repo, "add", "a.txt");
        await settle();
        expect(changes.length).toBeGreaterThanOrEqual(1);

        changes.length = 0;
        git(repo, "commit", "-q", "-m", "two");
        await settle();
        expect(changes.length).toBeGreaterThanOrEqual(1);
    }, 20_000);

    test("node_modules churn does not", async () => {
        mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
        await watchers.watch(repo, "w1");
        await quiet();
        for (let i = 0; i < 50; i++) writeFileSync(join(repo, "node_modules", "pkg", `f${i}.js`), "x");
        await settle();
        expect(changes).toEqual([]);
    }, 20_000);

    test("reading status does not wake its own watcher", async () => {
        await watchers.watch(repo, "w1");
        await quiet();
        // What the panel runs on every notification (git.ts reads with
        // GIT_OPTIONAL_LOCKS=0, so status does not rewrite the index).
        execFileSync("git", ["status", "--porcelain=v2"], {
            cwd: repo,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        });
        await settle();
        expect(changes).toEqual([]);
    }, 20_000);

    test("watches are shared per folder and leased", async () => {
        let now = 1_000;
        const leased = new GitWatchers({ onChange: () => {}, now: () => now });
        await leased.watch(repo, "a");
        await leased.watch(repo, "b");
        expect(leased.size).toBe(1);

        leased.unwatch("a");
        expect(leased.size).toBe(1);

        // "b" vanished without unwatching: closed once its lease runs out.
        now += GIT_WATCH_LEASE_MS - 1;
        leased.sweep();
        expect(leased.size).toBe(1);
        now += 2;
        leased.sweep();
        expect(leased.size).toBe(0);
        leased.closeAll();
    });

    test("a renewal keeps it open", async () => {
        let now = 1_000;
        const leased = new GitWatchers({ onChange: () => {}, now: () => now });
        await leased.watch(repo, "a");
        now += GIT_WATCH_LEASE_MS - 10;
        await leased.watch(repo, "a");
        now += 20;
        leased.sweep();
        expect(leased.size).toBe(1);
        leased.closeAll();
    });
});
