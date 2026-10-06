import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { status } from "../../src/workspace/git";
import { conflictStages, discardChanges, stageContent, stageFiles, unstageFiles } from "../../src/workspace/staging";

const exec = promisify(execFile);

/**
 * Real repositories throughout.
 *
 * These are writes against a git index; a fake would only prove that the
 * argument arrays are what this file already says they are. The point is
 * whether git agrees, so every assertion reads the state back out of git.
 */
let repo: string;

async function git(...args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, {
        cwd: repo,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "loop",
            GIT_AUTHOR_EMAIL: "loop@example.com",
            GIT_COMMITTER_NAME: "loop",
            GIT_COMMITTER_EMAIL: "loop@example.com",
        },
    });
    return stdout;
}

/** What git thinks is staged, straight from the horse's mouth. */
async function stagedPaths(): Promise<string[]> {
    return (await git("diff", "--cached", "--name-only")).split("\n").filter((line) => line !== "");
}

beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "loop-staging-"));
    await git("init", "--initial-branch=main");
});

afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
});

describe("staging whole files", () => {
    test("stages a modification, an addition and a deletion", async () => {
        await writeFile(join(repo, "kept.txt"), "one\n");
        await writeFile(join(repo, "doomed.txt"), "bye\n");
        await git("add", ".");
        await git("commit", "-m", "first");

        await writeFile(join(repo, "kept.txt"), "one\ntwo\n");
        await writeFile(join(repo, "fresh.txt"), "new\n");
        await rm(join(repo, "doomed.txt"));

        // A deletion is why this uses `add --all`: plain `git add` on a path that
        // no longer exists is an error, so the deletion would never stage.
        await stageFiles(repo, ["kept.txt", "fresh.txt", "doomed.txt"]);
        expect((await stagedPaths()).toSorted()).toEqual(["doomed.txt", "fresh.txt", "kept.txt"]);
    });

    test("unstages without touching the working tree", async () => {
        await writeFile(join(repo, "a.txt"), "one\n");
        await git("add", ".");
        await git("commit", "-m", "first");
        await writeFile(join(repo, "a.txt"), "one\ntwo\n");
        await stageFiles(repo, ["a.txt"]);
        expect(await stagedPaths()).toEqual(["a.txt"]);

        await unstageFiles(repo, ["a.txt"]);
        expect(await stagedPaths()).toEqual([]);
        // The edit itself must survive — unstage is not undo.
        expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    });

    test("unstages in a repository that has no commit yet", async () => {
        // Every project between `git init` and its first commit. `restore --staged`
        // resets to HEAD, and there is no HEAD, so this needs the other spelling —
        // invisible until someone actually tries it.
        await writeFile(join(repo, "first.txt"), "hello\n");
        await stageFiles(repo, ["first.txt"]);
        expect(await stagedPaths()).toEqual(["first.txt"]);

        await unstageFiles(repo, ["first.txt"]);
        expect(await stagedPaths()).toEqual([]);
        expect(existsSync(join(repo, "first.txt"))).toBe(true);
    });
});

describe("discarding", () => {
    test("restores a tracked file and deletes an untracked one", async () => {
        await writeFile(join(repo, "tracked.txt"), "original\n");
        await git("add", ".");
        await git("commit", "-m", "first");
        await writeFile(join(repo, "tracked.txt"), "ruined\n");
        await writeFile(join(repo, "junk.txt"), "garbage\n");

        await discardChanges(repo, { tracked: ["tracked.txt"], untracked: ["junk.txt"] });
        expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
        // `git restore` has no index entry to restore an untracked file from, so
        // it has to be removed directly.
        expect(existsSync(join(repo, "junk.txt"))).toBe(false);
    });

    test("discarding also drops what was staged for that file", async () => {
        await writeFile(join(repo, "a.txt"), "original\n");
        await git("add", ".");
        await git("commit", "-m", "first");
        await writeFile(join(repo, "a.txt"), "staged\n");
        await stageFiles(repo, ["a.txt"]);
        await writeFile(join(repo, "a.txt"), "and unstaged\n");

        await discardChanges(repo, { tracked: ["a.txt"], untracked: [] });
        expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("original\n");
        expect(await stagedPaths()).toEqual([]);
    });
});

describe("staging exact content", () => {
    test("stages content that is in neither HEAD nor the working tree", async () => {
        // The primitive behind hunk and line staging: the index gets the partial
        // result while the working tree keeps everything.
        await writeFile(join(repo, "a.txt"), "one\n");
        await git("add", ".");
        await git("commit", "-m", "first");
        await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");

        await stageContent(repo, "a.txt", "one\ntwo\n");

        expect(await git("show", ":a.txt")).toBe("one\ntwo\n");
        // Untouched on disk — that is the whole point.
        expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");

        const result = await status(repo);
        const change = result.changes.find((entry) => entry.path === "a.txt");
        expect([change?.staged, change?.unstaged]).toEqual([true, true]);
    });

    test("keeps the executable bit", async () => {
        // Read from the existing entry rather than assumed: staging a hunk of a
        // shell script must not quietly make it non-executable.
        await writeFile(join(repo, "run.sh"), "#!/bin/sh\necho one\n");
        await chmod(join(repo, "run.sh"), 0o755);
        await git("add", ".");
        await git("commit", "-m", "first");

        await stageContent(repo, "run.sh", "#!/bin/sh\necho two\n");
        const entry = await git("ls-files", "--stage", "--", "run.sh");
        expect(entry.startsWith("100755")).toBe(true);
    });

    test("stages content for a path git has never seen", async () => {
        // No index entry and no HEAD entry: this has to be --add'ed, not updated.
        await writeFile(join(repo, "seed.txt"), "x\n");
        await git("add", ".");
        await git("commit", "-m", "first");

        await stageContent(repo, "brand-new.txt", "partial\n");
        expect(await git("show", ":brand-new.txt")).toBe("partial\n");
        expect(await stagedPaths()).toContain("brand-new.txt");
    });

    test("stages content in a repository with no commit yet", async () => {
        await stageContent(repo, "first.txt", "hello\n");
        expect(await git("show", ":first.txt")).toBe("hello\n");
    });

    test("content with CRLF endings survives exactly", async () => {
        // `hash-object --path` applies the filters this path would be subject to,
        // which is what stops a CRLF file from acquiring spurious line-ending
        // changes the moment a single hunk is staged.
        await writeFile(join(repo, "dos.txt"), "one\r\ntwo\r\n");
        await git("add", ".");
        await git("commit", "-m", "first");

        await stageContent(repo, "dos.txt", "one\r\ntwo\r\nthree\r\n");
        expect(await git("show", ":dos.txt")).toBe("one\r\ntwo\r\nthree\r\n");
    });

    test("a file with no trailing newline stages without gaining one", async () => {
        // The `\ No newline at end of file` case, which is where patch-building
        // approaches go wrong. Nothing here builds a patch, so it simply holds.
        await writeFile(join(repo, "bare.txt"), "no newline");
        await git("add", ".");
        await git("commit", "-m", "first");

        await stageContent(repo, "bare.txt", "still no newline");
        expect(await git("show", ":bare.txt")).toBe("still no newline");
    });
});

describe("conflicts", () => {
    /** A repository stopped mid-merge, the way a user finds it. */
    async function conflict(): Promise<void> {
        await writeFile(join(repo, "shared.txt"), "base\n");
        await git("add", ".");
        await git("commit", "-m", "base");
        await git("checkout", "-b", "other");
        await writeFile(join(repo, "shared.txt"), "theirs\n");
        await git("commit", "-am", "theirs");
        await git("checkout", "main");
        await writeFile(join(repo, "shared.txt"), "ours\n");
        await git("commit", "-am", "ours");
        // Through the helper, so the merge has the same identity the commits used:
        // a machine with no global git config cannot merge without one. A
        // conflicting merge exits non-zero, which is the point of the catch.
        await git("merge", "other").catch(() => undefined);
    }

    test("reads the three sides out of the index stages", async () => {
        // Exactly what a three-way view needs, without re-running the merge or
        // parsing conflict markers back out of the working-tree file.
        await conflict();
        const stages = await conflictStages(repo, "shared.txt");
        expect(stages.base).toBe("base\n");
        expect(stages.ours).toBe("ours\n");
        expect(stages.theirs).toBe("theirs\n");
    });

    test("staging the resolution clears the conflict", async () => {
        await conflict();
        expect((await status(repo)).hasConflicts).toBe(true);

        await stageContent(repo, "shared.txt", "merged by hand\n");

        const result = await status(repo);
        expect(result.hasConflicts).toBe(false);
        const change = result.changes.find((entry) => entry.path === "shared.txt");
        expect(change?.conflict).toBeUndefined();
        expect(change?.staged).toBe(true);
    });

    test("a side that does not exist reads as null", async () => {
        // "both added" has no common ancestor; a view must not invent one.
        await writeFile(join(repo, "seed.txt"), "x\n");
        await git("add", ".");
        await git("commit", "-m", "seed");
        await git("checkout", "-b", "other");
        await writeFile(join(repo, "new.txt"), "theirs\n");
        await git("add", ".");
        await git("commit", "-m", "theirs");
        await git("checkout", "main");
        await writeFile(join(repo, "new.txt"), "ours\n");
        await git("add", ".");
        await git("commit", "-m", "ours");
        await git("merge", "other").catch(() => undefined);

        const stages = await conflictStages(repo, "new.txt");
        expect(stages.base).toBeNull();
        expect(stages.ours).toBe("ours\n");
        expect(stages.theirs).toBe("theirs\n");
    });
});
