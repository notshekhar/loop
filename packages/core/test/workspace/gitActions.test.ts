import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { featureBranchName, phasesFor, runStackedAction, type GitActionProgress } from "../../src/workspace/gitActions";

const run = promisify(execFile);

const AUTHOR = {
    GIT_AUTHOR_NAME: "loop",
    GIT_AUTHOR_EMAIL: "loop@example.com",
    GIT_COMMITTER_NAME: "loop",
    GIT_COMMITTER_EMAIL: "loop@example.com",
};

const made: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await run("git", args, { cwd, env: { ...process.env, ...AUTHOR } });
    return stdout;
}

/** A fresh repo. `commit: false` reproduces the stories shape: no HEAD at all. */
async function makeRepo(options: { commit?: boolean } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "loop-gitactions-"));
    made.push(dir);
    await git(dir, "init", "--initial-branch=main");
    // The identity goes in the repo's own config, not just this helper's env:
    // the code under test spawns its own git, which inherits none of it. A
    // developer machine has a global identity to fall back on and a fresh CI
    // runner does not, so without this every commit here fails with "Author
    // identity unknown" on CI alone.
    await git(dir, "config", "user.name", AUTHOR.GIT_AUTHOR_NAME);
    await git(dir, "config", "user.email", AUTHOR.GIT_AUTHOR_EMAIL);
    if (options.commit !== false) {
        await writeFile(join(dir, "base.txt"), "base\n");
        await git(dir, "add", ".");
        await git(dir, "commit", "-m", "base");
    }
    return dir;
}

function collector() {
    const events: GitActionProgress[] = [];
    return { events, emit: (event: GitActionProgress) => void events.push(event) };
}

afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("committing", () => {
    test("stages everything and commits with the given message", async () => {
        const repo = await makeRepo();
        await writeFile(join(repo, "a.txt"), "new\n");
        const { events, emit } = collector();

        const result = await runStackedAction(repo, { action: "commit", commitMessage: "Add a.txt" }, { emit });

        expect(result.commit.status).toBe("created");
        expect(result.commit.subject).toBe("Add a.txt");
        expect(result.commit.commitSha).toMatch(/^[0-9a-f]{40}$/);
        // The untracked file made it in — "what changed" is not "what I remembered
        // to git add".
        expect(await git(repo, "show", "--name-only", "--format=%s", "HEAD")).toContain("a.txt");
        expect(events.some((e) => e.kind === "action_started")).toBe(true);
    });

    test("commits in a repo that has no commits yet", async () => {
        // The `stories` shape: `git init`, never committed, so HEAD does not exist.
        const repo = await makeRepo({ commit: false });
        await writeFile(join(repo, "story.md"), "once\n");
        const { emit } = collector();

        const result = await runStackedAction(repo, { action: "commit", commitMessage: "First story" }, { emit });

        expect(result.commit.status).toBe("created");
        expect((await git(repo, "log", "--oneline")).trim()).toContain("First story");
    });

    test("commits only the paths it was given", async () => {
        const repo = await makeRepo();
        await writeFile(join(repo, "wanted.txt"), "yes\n");
        await writeFile(join(repo, "unwanted.txt"), "no\n");
        const { emit } = collector();

        await runStackedAction(
            repo,
            { action: "commit", commitMessage: "Only wanted", filePaths: ["wanted.txt"] },
            { emit },
        );

        const committed = await git(repo, "show", "--name-only", "--format=", "HEAD");
        expect(committed).toContain("wanted.txt");
        expect(committed).not.toContain("unwanted.txt");
        // And the other file is still sitting there untracked, not silently swept in.
        expect(await git(repo, "status", "--porcelain")).toContain("unwanted.txt");
    });

    test("reports nothing to commit rather than failing", async () => {
        // `commit_push` on an already-committed branch reaches the push this way.
        const repo = await makeRepo();
        const { emit } = collector();

        const result = await runStackedAction(repo, { action: "commit" }, { emit });

        expect(result.commit.status).toBe("skipped_no_changes");
    });

    test("asks for a message when none was given, and passes the staged diff", async () => {
        const repo = await makeRepo();
        await writeFile(join(repo, "feature.ts"), "export const x = 1;\n");
        const { events, emit } = collector();
        const seen: string[] = [];

        const result = await runStackedAction(
            repo,
            { action: "commit" },
            {
                emit,
                generateMessage: async ({ diff }) => {
                    seen.push(diff);
                    return "Add the x export";
                },
            },
        );

        expect(result.commit.subject).toBe("Add the x export");
        // It must see the staged content, or it is describing nothing.
        expect(seen[0]).toContain("export const x = 1;");
        expect(events.some((e) => e.kind === "phase_started" && e.label.includes("Generating"))).toBe(true);
    });

    test("still commits when message generation fails", async () => {
        // Losing a staged commit because a summarizer had a bad day is a worse
        // outcome than an unglamorous subject line.
        const repo = await makeRepo();
        await writeFile(join(repo, "a.txt"), "new\n");
        const { emit } = collector();

        const result = await runStackedAction(
            repo,
            { action: "commit" },
            { emit, generateMessage: () => Promise.reject(new Error("model down")) },
        );

        expect(result.commit.status).toBe("created");
        expect(result.commit.subject).toBe("Update 1 file");
    });

    test("creates a feature branch named for the message", async () => {
        const repo = await makeRepo();
        await writeFile(join(repo, "a.txt"), "new\n");
        const { emit } = collector();

        const result = await runStackedAction(
            repo,
            { action: "commit", commitMessage: "Add the widget", featureBranch: true },
            { emit },
        );

        expect(result.branch).toEqual({ status: "created", name: "loop/add-the-widget" });
        // The commit landed on the new branch, not on main.
        expect((await git(repo, "branch", "--show-current")).trim()).toBe("loop/add-the-widget");
        expect(await git(repo, "log", "--oneline", "main")).not.toContain("Add the widget");
    });

    test("surfaces a failing pre-commit hook's output and does not commit", async () => {
        const repo = await makeRepo();
        await mkdir(join(repo, ".git", "hooks"), { recursive: true });
        const hook = join(repo, ".git", "hooks", "pre-commit");
        await writeFile(hook, "#!/bin/sh\necho 'lint failed on a.txt'\nexit 1\n");
        await chmod(hook, 0o755);
        await writeFile(join(repo, "a.txt"), "new\n");
        const { events, emit } = collector();

        await expect(
            runStackedAction(repo, { action: "commit", commitMessage: "Add a.txt" }, { emit }),
        ).rejects.toThrow(/lint failed on a.txt/);

        expect(events.some((e) => e.kind === "hook_started" && e.hookName === "pre-commit")).toBe(true);
        expect(events.some((e) => e.kind === "hook_finished")).toBe(true);
        // The commit did not happen.
        expect(await git(repo, "log", "--oneline")).not.toContain("Add a.txt");
    });

    test("says nothing about hooks in a repo that has none", async () => {
        const repo = await makeRepo();
        await writeFile(join(repo, "a.txt"), "new\n");
        const { events, emit } = collector();

        await runStackedAction(repo, { action: "commit", commitMessage: "Add a.txt" }, { emit });

        expect(events.some((e) => e.kind === "hook_started")).toBe(false);
    });

    test("refuses a folder that is not a repository", async () => {
        const plain = await mkdtemp(join(tmpdir(), "loop-plain-"));
        made.push(plain);
        const { emit } = collector();

        await expect(runStackedAction(plain, { action: "commit" }, { emit })).rejects.toThrow(/not a git repository/);
    });
});

describe("pushing", () => {
    /** A repo with a real (bare, local) origin, so push is exercised for real. */
    async function repoWithOrigin(): Promise<{ repo: string; origin: string }> {
        const origin = await mkdtemp(join(tmpdir(), "loop-origin-"));
        made.push(origin);
        await run("git", ["init", "--bare", "--initial-branch=main"], { cwd: origin });
        const repo = await makeRepo();
        await git(repo, "remote", "add", "origin", origin);
        return { repo, origin };
    }

    test("sets upstream on a branch that has none", async () => {
        const { repo } = await repoWithOrigin();
        const { emit } = collector();

        const result = await runStackedAction(repo, { action: "push" }, { emit });

        expect(result.push.status).toBe("pushed");
        expect(result.push.setUpstream).toBe(true);
        expect((await git(repo, "rev-parse", "--abbrev-ref", "main@{u}")).trim()).toBe("origin/main");
    });

    test("skips a push that would change nothing", async () => {
        const { repo } = await repoWithOrigin();
        const first = collector();
        await runStackedAction(repo, { action: "push" }, { emit: first.emit });
        const second = collector();

        const result = await runStackedAction(repo, { action: "push" }, { emit: second.emit });

        expect(result.push.status).toBe("skipped_up_to_date");
        // And it did not pretend to do work.
        expect(second.events.some((e) => e.kind === "phase_started" && e.phase === "push")).toBe(false);
    });

    test("commits and pushes in one action", async () => {
        const { repo, origin } = await repoWithOrigin();
        await writeFile(join(repo, "a.txt"), "new\n");
        const { emit } = collector();

        const result = await runStackedAction(repo, { action: "commit_push", commitMessage: "Add a.txt" }, { emit });

        expect(result.commit.status).toBe("created");
        expect(result.push.status).toBe("pushed");
        expect(await git(origin, "log", "--oneline")).toContain("Add a.txt");
    });

    test("reports the real error when there is no remote to push to", async () => {
        const repo = await makeRepo();
        const { emit } = collector();

        await expect(runStackedAction(repo, { action: "push" }, { emit })).rejects.toThrow(/git push failed/);
    });
});

describe("phase planning", () => {
    test("lists only the phases that will run", () => {
        expect(phasesFor({ action: "commit" }, true)).toEqual(["commit"]);
        expect(phasesFor({ action: "push" }, true)).toEqual(["push"]);
        expect(phasesFor({ action: "commit_push" }, true)).toEqual(["commit", "push"]);
        expect(phasesFor({ action: "commit_push_pr" }, true)).toEqual(["commit", "push", "pr"]);
        expect(phasesFor({ action: "commit", featureBranch: true }, true)).toEqual(["branch", "commit"]);
        // Nothing staged: commit_push is on its way to the push, so no commit stage.
        expect(phasesFor({ action: "commit_push" }, false)).toEqual(["push"]);
    });
});

describe("feature branch names", () => {
    test("slugs the subject", () => {
        expect(featureBranchName("Add the widget")).toBe("loop/add-the-widget");
        expect(featureBranchName("Fix: don't crash on empty input!")).toBe("loop/fix-don-t-crash-on-empty-input");
    });

    test("falls back to a stamp when the subject slugs to nothing", () => {
        // A non-Latin subject is the real case here, not a contrived one.
        expect(featureBranchName("修复错误", new Date("2026-08-08T10:30:00Z"))).toBe("loop/change-202608081030");
    });
});
