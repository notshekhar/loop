import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
    MAX_CONCURRENT_GIT,
    diffPreview,
    gitInvocationCount,
    repositorySummary,
    status,
    withGitSlot,
    workspaceRepositories,
} from "../../src/workspace/git";

const run = promisify(execFile);

/** A repo with one commit on `main`, one edit, and one untracked file. */
let repo: string;

async function git(...args: string[]): Promise<void> {
    await run("git", args, {
        cwd: repo,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "loop",
            GIT_AUTHOR_EMAIL: "loop@example.com",
            GIT_COMMITTER_NAME: "loop",
            GIT_COMMITTER_EMAIL: "loop@example.com",
        },
    });
}

beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "loop-git-"));
    await git("init", "--initial-branch=main");
    await writeFile(join(repo, "tracked.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-m", "first");

    await git("checkout", "-b", "feature");
    await writeFile(join(repo, "tracked.txt"), "one\ntwo\n");
    await git("commit", "-am", "second");

    await writeFile(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
    await writeFile(join(repo, "untracked.txt"), "fresh\n");
});

afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
});

describe("diffPreview", () => {
    test("reports a folder that is not a repository", async () => {
        const plain = await mkdtemp(join(tmpdir(), "loop-plain-"));
        try {
            expect(await diffPreview(plain)).toEqual({ isRepo: false, sources: [] });
        } finally {
            await rm(plain, { recursive: true, force: true });
        }
    });

    test("returns every source with stable hashes", async () => {
        const preview = await diffPreview(repo);
        expect(preview.isRepo).toBe(true);
        // The review pane's two, then the SCM panel's two halves. Order matters
        // only in that the original pair stays first; everything picks by id.
        expect(preview.sources.map((source) => source.kind)).toEqual([
            "working-tree",
            "branch-range",
            "staged",
            "unstaged",
        ]);
        for (const source of preview.sources) {
            expect(source.diffHash).toMatch(/^[0-9a-f]{64}$/);
            expect(source.truncated).toBe(false);
        }
    });

    test("the working tree covers uncommitted edits and untracked files", async () => {
        const [workingTree] = (await diffPreview(repo)).sources;
        expect(workingTree?.baseRef).toBe("HEAD");
        // The edit that was never committed, not the one that was.
        expect(workingTree?.diff).toContain("+three");
        expect(workingTree?.diff).not.toContain("+two");
        // Untracked files are absent from `git diff`, so they are diffed apart.
        expect(workingTree?.diff).toContain("untracked.txt");
        expect(workingTree?.diff).toContain("+fresh");
    });

    test("the branch range is measured against the base branch", async () => {
        const [, range] = (await diffPreview(repo)).sources;
        expect(range?.baseRef).toBe("main");
        expect(range?.headRef).toBe("feature");
        // `main...HEAD` is what the branch added, so the committed line is in and
        // the uncommitted one is not.
        expect(range?.diff).toContain("+two");
        expect(range?.diff).not.toContain("+three");
    });

    test("an explicit base ref wins over the guess", async () => {
        const [, range] = (await diffPreview(repo, { baseRef: "feature" })).sources;
        expect(range?.baseRef).toBe("feature");
        expect(range?.diff).toBe("");
    });
});

/** A folder that is not a repository but holds two, one of them nested. */
describe("a folder of repositories", () => {
    let workspace: string;

    const commit = (cwd: string, ...args: string[]) =>
        run("git", args, {
            cwd,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "loop",
                GIT_AUTHOR_EMAIL: "loop@example.com",
                GIT_COMMITTER_NAME: "loop",
                GIT_COMMITTER_EMAIL: "loop@example.com",
            },
        });

    beforeAll(async () => {
        workspace = await mkdtemp(join(tmpdir(), "loop-workspace-"));
        for (const relative of ["payments", join("group", "billing")]) {
            const service = join(workspace, relative);
            await mkdir(join(service, "src"), { recursive: true });
            await commit(service, "init", "--initial-branch=main");
            await writeFile(join(service, "src", "index.ts"), "one\n");
            await commit(service, "add", ".");
            await commit(service, "commit", "-m", "first");
            await writeFile(join(service, "src", "index.ts"), "one\ntwo\n");
            await writeFile(join(service, "src", "new.ts"), "fresh\n");
        }
        await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    });

    afterAll(async () => {
        await rm(workspace, { recursive: true, force: true });
    });

    test("finds repositories one and two levels down, and skips the rest", async () => {
        expect(await workspaceRepositories(workspace)).toEqual(["group/billing", "payments"]);
    });

    test("reports itself as a repository so the diff panel opens", async () => {
        const workspaceStatus = await status(workspace);
        expect(workspaceStatus.isRepo).toBe(true);
        expect(workspaceStatus.refName).toBe("main");
        expect(workspaceStatus.workingTree.files.map((file) => file.path)).toContain("payments/src/index.ts");
        // Nothing to push from a folder that is not itself a repository.
        expect(workspaceStatus.hasPrimaryRemote).toBe(false);
        expect(workspaceStatus.hasUpstream).toBe(false);
    });

    test("lists the repositories instead of one giant patch", async () => {
        const preview = await diffPreview(workspace);
        expect(preview.isRepo).toBe(true);
        // Nothing to diff at this level; the panel opens one repository at a time.
        expect(preview.sources).toEqual([]);
        expect(preview.workspaceRepositories?.map((repo) => repo.path)).toEqual(["group/billing", "payments"]);
        const [first] = preview.workspaceRepositories ?? [];
        expect(first?.branch).toBe("main");
        // One edited file and one untracked, in each service.
        expect(first?.filesChanged).toBe(2);
        expect(first?.insertions).toBe(1);
    });

    test("sorts repositories with changes above quiet ones", async () => {
        const quiet = join(workspace, "quiet");
        await mkdir(quiet, { recursive: true });
        await commit(quiet, "init", "--initial-branch=main");
        await writeFile(join(quiet, "only.txt"), "committed\n");
        await commit(quiet, "add", ".");
        await commit(quiet, "commit", "-m", "first");
        try {
            const preview = await diffPreview(workspace);
            const paths = preview.workspaceRepositories?.map((repo) => repo.path) ?? [];
            // Both changed services come first; the clean one sinks to the bottom.
            expect(paths.at(-1)).toBe("quiet");
            expect(preview.workspaceRepositories?.at(-1)?.filesChanged).toBe(0);
        } finally {
            await rm(quiet, { recursive: true, force: true });
        }
    });

    test("a repository inside the folder still diffs normally", async () => {
        const preview = await diffPreview(join(workspace, "payments"));
        expect(preview.isRepo).toBe(true);
        expect(preview.workspaceRepositories).toBeUndefined();
        const [workingTree] = preview.sources;
        // Unprefixed: the panel asked for this repository, so paths are its own.
        expect(workingTree?.diff).toContain("b/src/index.ts");
        expect(workingTree?.diff).toContain("--- /dev/null");
    });

    test("a folder with neither a repository nor children is still not a repo", async () => {
        const empty = await mkdtemp(join(tmpdir(), "loop-empty-"));
        try {
            expect(await diffPreview(empty)).toEqual({ isRepo: false, sources: [] });
            expect((await status(empty)).isRepo).toBe(false);
        } finally {
            await rm(empty, { recursive: true, force: true });
        }
    });
});

/**
 * The spawn gate.
 *
 * `uv_spawn` blocks the thread it is called on, and in the desktop app that
 * thread also runs loop's core — so an unbounded `Promise.all` over git
 * commands freezes the agent mid-turn. These pin the two properties that stop
 * that: the pool never exceeds its ceiling, and a big fan-out never becomes
 * one long block.
 */
describe("git spawn concurrency", () => {
    test("a batch fan-out never exceeds the ceiling", async () => {
        let active = 0;
        let peak = 0;
        const release: Array<() => void> = [];

        // Twice the ceiling, so the second half can only run by waiting.
        const running = Array.from({ length: MAX_CONCURRENT_GIT * 2 }, () =>
            withGitSlot(async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise<void>((resolve) => release.push(resolve));
                active -= 1;
            }),
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(peak).toBe(MAX_CONCURRENT_GIT);

        while (release.length > 0) {
            release.shift()?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await Promise.all(running);

        expect(peak).toBe(MAX_CONCURRENT_GIT);
        expect(active).toBe(0);
    });

    /**
     * A fan-out alone cannot catch the release race, because every acquire in it
     * comes from the wait queue and those stay balanced. The overshoot needs a
     * caller arriving from OUTSIDE the queue — in the desktop app, a `git.status`
     * poll landing while `diffPreview` is fanning out — during the window where a
     * decrement has already happened but the waiter it woke has not yet resumed.
     *
     * MEASURED: that window is exactly one microtask wide. Pinning the test to
     * that single depth would make it stop catching anything the moment
     * `withGitSlot` gains or loses an `await` — and it would stop by PASSING,
     * which is the worst way for a guard to fail. So this sweeps the depths
     * around it and asserts the ceiling holds at every one.
     */
    test("a fresh arrival cannot barge a slot promised to a waiter", async () => {
        for (let microtaskDepth = 0; microtaskDepth <= 6; microtaskDepth++) {
            let active = 0;
            let peak = 0;
            const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
            const releases: Array<() => void> = [];
            const pending: Array<Promise<unknown>> = [];

            const occupy = () =>
                withGitSlot(async () => {
                    active += 1;
                    peak = Math.max(peak, active);
                    await new Promise<void>((resolve) => releases.push(resolve));
                    active -= 1;
                });

            // Fill every slot, then queue one waiter behind them.
            const held = Array.from({ length: MAX_CONCURRENT_GIT }, occupy);
            await settle();
            pending.push(occupy());
            await settle();

            // One holder finishes, handing its slot to that waiter...
            releases[0]?.();
            for (let i = 0; i < microtaskDepth; i++) await Promise.resolve();
            // ...and an unrelated caller arrives mid-handover.
            pending.push(occupy());
            await settle();

            expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_GIT);

            for (const release of releases) release();
            await settle();
            for (const release of releases) release();
            await Promise.all([...held, ...pending]);
            expect(active).toBe(0);
        }
    });

    test("a slot survives work that throws", async () => {
        await Promise.all(
            Array.from({ length: MAX_CONCURRENT_GIT * 3 }, () =>
                withGitSlot(() => Promise.reject(new Error("boom"))).catch(() => {}),
            ),
        );
        // A leaked slot would shrink the pool permanently; if none leaked, a fresh
        // batch can still fill it.
        let peak = 0;
        let active = 0;
        await Promise.all(
            Array.from({ length: MAX_CONCURRENT_GIT }, () =>
                withGitSlot(async () => {
                    active += 1;
                    peak = Math.max(peak, active);
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    active -= 1;
                }),
            ),
        );
        expect(peak).toBe(MAX_CONCURRENT_GIT);
    });

    test("a wide untracked diff does not block the event loop", async () => {
        const wide = await mkdtemp(join(tmpdir(), "loop-wide-"));
        try {
            await run("git", ["init", "--initial-branch=main"], { cwd: wide });
            await writeFile(join(wide, "seed.txt"), "seed\n");
            await run("git", ["add", "."], { cwd: wide });
            await run("git", ["commit", "-m", "seed"], {
                cwd: wide,
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: "loop",
                    GIT_AUTHOR_EMAIL: "loop@example.com",
                    GIT_COMMITTER_NAME: "loop",
                    GIT_COMMITTER_EMAIL: "loop@example.com",
                },
            });
            // Each untracked file is its own `git diff --no-index` process.
            await Promise.all(
                Array.from({ length: 150 }, (_, index) =>
                    writeFile(join(wide, `new-${index}.txt`), `content ${index}\n`),
                ),
            );

            // A timer that should fire every 5ms; the worst overshoot is how long
            // the loop was held. Unbounded, this measured >200ms.
            let worst = 0;
            let last = performance.now();
            const ticker = setInterval(() => {
                const now = performance.now();
                worst = Math.max(worst, now - last - 5);
                last = now;
            }, 5);

            const preview = await diffPreview(wide);
            clearInterval(ticker);

            expect(preview.isRepo).toBe(true);
            expect(preview.sources[0]?.diff).toContain("new-0.txt");
            // Generous: the measured gap is ~3ms bounded vs ~217ms unbounded, so
            // this fails only on a genuine regression, not on a loaded CI box.
            expect(worst).toBeLessThan(75);
        } finally {
            await rm(wide, { recursive: true, force: true });
        }
    });
});

/**
 * The index, which the flat list could not represent.
 *
 * `status` used to answer with `git diff --numstat HEAD`, which fuses the index
 * and the working tree — so a file staged and then edited again was one row
 * with one line count belonging to neither side, and a conflict was
 * indistinguishable from an ordinary modification. These build the states in a
 * real repository, because the value of the new fields is entirely in whether
 * they match what git itself reports.
 */
describe("index-aware status", () => {
    let sandbox: string;

    async function run2(cwd: string, ...args: string[]): Promise<void> {
        await run("git", args, {
            cwd,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "loop",
                GIT_AUTHOR_EMAIL: "loop@example.com",
                GIT_COMMITTER_NAME: "loop",
                GIT_COMMITTER_EMAIL: "loop@example.com",
            },
        });
    }

    beforeAll(async () => {
        sandbox = await mkdtemp(join(tmpdir(), "loop-index-"));
        await run2(sandbox, "init", "--initial-branch=main");
        await writeFile(join(sandbox, "both.txt"), "one\n");
        await writeFile(join(sandbox, "staged.txt"), "a\n");
        await writeFile(join(sandbox, "dirty.txt"), "b\n");
        await run2(sandbox, "add", ".");
        await run2(sandbox, "commit", "-m", "first");

        // Staged, then edited again — the case with two different diffs.
        await writeFile(join(sandbox, "both.txt"), "one\ntwo\n");
        await run2(sandbox, "add", "both.txt");
        await writeFile(join(sandbox, "both.txt"), "one\ntwo\nthree\n");
        // Staged only.
        await writeFile(join(sandbox, "staged.txt"), "a\nstaged\n");
        await run2(sandbox, "add", "staged.txt");
        // Unstaged only, plus an untracked file.
        await writeFile(join(sandbox, "dirty.txt"), "b\ndirty\n");
        await writeFile(join(sandbox, "new.txt"), "fresh\n");
    });

    afterAll(async () => {
        await rm(sandbox, { recursive: true, force: true });
    });

    test("a file staged and edited again appears on both sides, with each side's own counts", async () => {
        const result = await status(sandbox);
        const both = result.changes.find((change) => change.path === "both.txt");
        expect(both?.staged).toBe(true);
        expect(both?.unstaged).toBe(true);
        expect(both?.indexStatus).toBe("M");
        expect(both?.worktreeStatus).toBe("M");
        // One line staged, a different line not — the numbers the two groups show.
        expect(both?.stagedInsertions).toBe(1);
        expect(both?.unstagedInsertions).toBe(1);
    });

    test("separates staged-only from unstaged-only", async () => {
        const result = await status(sandbox);
        const staged = result.changes.find((change) => change.path === "staged.txt");
        expect([staged?.staged, staged?.unstaged]).toEqual([true, false]);
        const dirty = result.changes.find((change) => change.path === "dirty.txt");
        expect([dirty?.staged, dirty?.unstaged]).toEqual([false, true]);
    });

    test("untracked files are unstaged and carry no line counts", async () => {
        const result = await status(sandbox);
        const fresh = result.changes.find((change) => change.path === "new.txt");
        expect(fresh?.untracked).toBe(true);
        expect(fresh?.unstaged).toBe(true);
        expect(fresh?.stagedInsertions).toBe(0);
    });

    test("counts each side", async () => {
        const result = await status(sandbox);
        // both + staged staged; both + dirty + new unstaged.
        expect(result.stagedCount).toBe(2);
        expect(result.unstagedCount).toBe(3);
        expect(result.hasConflicts).toBe(false);
    });

    test("the old flat list still answers exactly as it did", async () => {
        // The whole point of adding beside rather than replacing: the current panel
        // keeps working while the new model is built out.
        const result = await status(sandbox);
        const paths = result.workingTree.files.map((file) => file.path).toSorted();
        expect(paths).toEqual(["both.txt", "dirty.txt", "new.txt", "staged.txt"]);
        expect(result.hasWorkingTreeChanges).toBe(true);
    });

    test("a real merge conflict is its own state, in neither group", async () => {
        const conflicted = await mkdtemp(join(tmpdir(), "loop-conflict-"));
        try {
            await run2(conflicted, "init", "--initial-branch=main");
            await writeFile(join(conflicted, "base.txt"), "base\n");
            await run2(conflicted, "add", ".");
            await run2(conflicted, "commit", "-m", "base");
            await run2(conflicted, "checkout", "-b", "other");
            await writeFile(join(conflicted, "war.txt"), "theirs\n");
            await run2(conflicted, "add", ".");
            await run2(conflicted, "commit", "-m", "theirs");
            await run2(conflicted, "checkout", "main");
            await writeFile(join(conflicted, "war.txt"), "ours\n");
            await run2(conflicted, "add", ".");
            await run2(conflicted, "commit", "-m", "ours");
            // Through `run2`, so the merge gets the same identity every commit above
            // used: a runner with no global git config cannot merge without one, and
            // the failure would otherwise be swallowed and read as "no conflict".
            // A conflicting merge exits non-zero, which is the expected outcome here.
            await run2(conflicted, "merge", "other").catch(() => undefined);

            // Assert against git itself before trusting the parse: if the merge did
            // not actually conflict, the interesting assertion below would fail for a
            // reason that has nothing to do with the code under test.
            const raw = await run("git", ["status", "--porcelain=v2", "-z"], { cwd: conflicted });
            expect(raw.stdout.includes("u ")).toBe(true);

            const result = await status(conflicted);
            expect(result.hasConflicts).toBe(true);
            const war = result.changes.find((change) => change.path === "war.txt");
            expect(war?.conflict).toBe("both-added");
            // Offering stage or unstage on a conflict would be a lie; it needs
            // resolving first.
            expect(war?.staged).toBe(false);
            expect(war?.unstaged).toBe(false);
        } finally {
            await rm(conflicted, { recursive: true, force: true });
        }
    });
});

/**
 * The per-side patches the two groups render.
 *
 * `working-tree` fuses the index and the working tree, so for a file that was
 * staged and then edited again it shows one combined patch belonging to
 * neither group. These are the two halves, and the test that matters is that
 * they disagree — if both showed the same hunk the split would be decorative.
 */
describe("staged and unstaged diff sources", () => {
    let sandbox: string;

    async function run3(cwd: string, ...args: string[]): Promise<void> {
        await run("git", args, {
            cwd,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "loop",
                GIT_AUTHOR_EMAIL: "loop@example.com",
                GIT_COMMITTER_NAME: "loop",
                GIT_COMMITTER_EMAIL: "loop@example.com",
            },
        });
    }

    beforeAll(async () => {
        sandbox = await mkdtemp(join(tmpdir(), "loop-sides-"));
        await run3(sandbox, "init", "--initial-branch=main");
        await writeFile(join(sandbox, "file.txt"), "one\n");
        await run3(sandbox, "add", ".");
        await run3(sandbox, "commit", "-m", "first");

        await writeFile(join(sandbox, "file.txt"), "one\nSTAGED\n");
        await run3(sandbox, "add", "file.txt");
        await writeFile(join(sandbox, "file.txt"), "one\nSTAGED\nUNSTAGED\n");
        await writeFile(join(sandbox, "extra.txt"), "untracked\n");
    });

    afterAll(async () => {
        await rm(sandbox, { recursive: true, force: true });
    });

    test("each side carries only its own change", async () => {
        const preview = await diffPreview(sandbox);
        const staged = preview.sources.find((source) => source.id === "staged");
        const unstaged = preview.sources.find((source) => source.id === "unstaged");

        expect(staged?.diff).toContain("+STAGED");
        expect(staged?.diff).not.toContain("+UNSTAGED");

        expect(unstaged?.diff).toContain("+UNSTAGED");
        expect(unstaged?.diff).not.toContain("+STAGED");
    });

    test("untracked files are unstaged, never staged", async () => {
        // They have no index entry at all, so nothing about them is staged.
        const preview = await diffPreview(sandbox);
        expect(preview.sources.find((source) => source.id === "unstaged")?.diff).toContain("extra.txt");
        expect(preview.sources.find((source) => source.id === "staged")?.diff).not.toContain("extra.txt");
    });

    test("the original two sources are untouched and still first", async () => {
        // The review pane picks by id and must keep getting what it always got.
        const preview = await diffPreview(sandbox);
        expect(preview.sources.slice(0, 2).map((source) => source.id)).toEqual(["working-tree", "branch-range"]);
        const workingTree = preview.sources[0];
        expect(workingTree?.diff).toContain("+STAGED");
        expect(workingTree?.diff).toContain("+UNSTAGED");
    });
});

/**
 * What a repository row costs.
 *
 * The folder-of-repositories list calls this once per repository, so its cost
 * is multiplied by however many checkouts someone keeps in a folder — fifty is
 * ordinary. It went through `status`, which answers seven commands' worth of
 * questions the row never asks, and the waste was felt as the folder appearing
 * to hang rather than as a number anyone could see.
 */
describe("repository summaries", () => {
    test("reports the branch, the file count and the line counts", async () => {
        const summary = await repositorySummary(repo);
        expect(summary.branch).toBe("feature");
        // The edited file and the untracked one.
        expect(summary.filesChanged).toBe(2);
        expect(summary.insertions).toBe(1);
        expect(summary.files.map((file) => file.path).toSorted()).toEqual(["tracked.txt", "untracked.txt"]);
    });

    test("agrees with the full status it replaced", async () => {
        // The row would otherwise be quietly wrong in a way nothing else checks.
        // The two do differ on one point by design: a summary counts an untracked
        // DIRECTORY as one entry where the full status lists every file inside it,
        // which is what makes the summary cheap. This fixture has an untracked
        // file rather than a directory, so the counts coincide.
        const [summary, full] = await Promise.all([repositorySummary(repo), status(repo)]);
        expect(summary.branch).toBe(full.refName);
        expect(summary.filesChanged).toBe(full.workingTree.files.length);
        expect(summary.insertions).toBe(full.workingTree.insertions);
        expect(summary.deletions).toBe(full.workingTree.deletions);
    });

    test("spends two git invocations, not seven", async () => {
        // The entire point of the function. A regression here is invisible on one
        // repository and painful on fifty, so it is pinned rather than trusted.
        const before = gitInvocationCount();
        await repositorySummary(repo);
        expect(gitInvocationCount() - before).toBe(2);
    });

    test("has no branch to report on a detached HEAD", async () => {
        const detached = await mkdtemp(join(tmpdir(), "loop-detached-"));
        try {
            const run3 = (...args: string[]) =>
                run("git", args, {
                    cwd: detached,
                    env: {
                        ...process.env,
                        GIT_AUTHOR_NAME: "loop",
                        GIT_AUTHOR_EMAIL: "loop@example.com",
                        GIT_COMMITTER_NAME: "loop",
                        GIT_COMMITTER_EMAIL: "loop@example.com",
                    },
                });
            await run3("init", "--initial-branch=main");
            await writeFile(join(detached, "a.txt"), "one\n");
            await run3("add", ".");
            await run3("commit", "-m", "first");
            const { stdout } = await run3("rev-parse", "HEAD");
            await run3("checkout", stdout.trim());

            // `# branch.head (detached)` is not a branch name to put in a row.
            expect((await repositorySummary(detached)).branch).toBeNull();
        } finally {
            await rm(detached, { recursive: true, force: true });
        }
    });
});

/**
 * The cost of an untracked directory.
 *
 * Enumerating every untracked file is what made a folder of repositories slow:
 * a repository holding an unignored `node_modules` is walked in its entirety to
 * answer a question a summary row does not ask.
 */
test("a summary counts an untracked directory as one entry", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "loop-untracked-"));
    try {
        const run4 = (...args: string[]) =>
            run("git", args, {
                cwd: sandbox,
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: "loop",
                    GIT_AUTHOR_EMAIL: "loop@example.com",
                    GIT_COMMITTER_NAME: "loop",
                    GIT_COMMITTER_EMAIL: "loop@example.com",
                },
            });
        await run4("init", "--initial-branch=main");
        await writeFile(join(sandbox, "tracked.txt"), "one\n");
        await run4("add", ".");
        await run4("commit", "-m", "first");
        await mkdir(join(sandbox, "heavy"), { recursive: true });
        for (let index = 0; index < 25; index++) {
            await writeFile(join(sandbox, "heavy", `file-${index}.txt`), "x\n");
        }

        // One row for `heavy/`, not twenty-five — the whole point.
        expect((await repositorySummary(sandbox)).filesChanged).toBe(1);
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});
