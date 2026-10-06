import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createDirectory, readWorkspaceFile, writeWorkspaceFile } from "../../src/workspace/workspaceFiles";

const roots: string[] = [];

async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "loop-workspace-"));
    roots.push(root);
    return root;
}

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("readWorkspaceFile", () => {
    test("reads a path relative to the cwd", async () => {
        const root = await workspace();
        await writeFile(join(root, "note.md"), "hello");

        const result = await readWorkspaceFile(root, "note.md");
        expect(result).toMatchObject({ ok: true, contents: "hello", relativePath: "note.md" });
    });

    test("resolves a path that repeats the cwd's own last segment", async () => {
        // The case from the chat: the agent runs in `<repo>/stories` and writes
        // `stories/monday-shirt.md`, meaning the path from the repository root.
        const repo = await workspace();
        const stories = join(repo, "stories");
        await mkdir(stories);
        await writeFile(join(stories, "monday-shirt.md"), "Monday's Shirt");

        const result = await readWorkspaceFile(stories, "stories/monday-shirt.md");
        expect(result).toMatchObject({
            ok: true,
            contents: "Monday's Shirt",
            relativePath: "monday-shirt.md",
        });
    });

    test("prefers a literal match over the overlap reading", async () => {
        const repo = await workspace();
        const stories = join(repo, "stories");
        await mkdir(join(stories, "stories"), { recursive: true });
        await writeFile(join(stories, "monday-shirt.md"), "collapsed");
        await writeFile(join(stories, "stories", "monday-shirt.md"), "literal");

        const result = await readWorkspaceFile(stories, "stories/monday-shirt.md");
        expect(result).toMatchObject({ ok: true, contents: "literal" });
    });

    test("still reports a path that exists under neither reading", async () => {
        const root = await workspace();
        const result = await readWorkspaceFile(root, "nope/missing.md");
        expect(result).toEqual({ ok: false, failure: "path_not_found" });
    });

    test("refuses to escape the root", async () => {
        const root = await workspace();
        const result = await readWorkspaceFile(root, "../../etc/passwd");
        expect(result).toEqual({ ok: false, failure: "resolved_path_outside_root" });
    });
});

/**
 * Saving an edited file.
 *
 * The editor treats anything but a success as "still unsaved", so a write that
 * quietly lands somewhere else is worse than one that fails: the tab looks
 * saved and the edit is gone.
 */
describe("writeWorkspaceFile", () => {
    test("writes a path relative to the cwd", async () => {
        const root = await workspace();
        await writeFile(join(root, "note.md"), "before");

        const result = await writeWorkspaceFile(root, "note.md", "after");
        expect(result).toEqual({ ok: true, relativePath: "note.md" });
        expect(await readFile(join(root, "note.md"), "utf8")).toBe("after");
    });

    test("creates a file that does not exist yet", async () => {
        const root = await workspace();
        const result = await writeWorkspaceFile(root, "fresh.txt", "new");
        expect(result.ok).toBe(true);
        expect(await readFile(join(root, "fresh.txt"), "utf8")).toBe("new");
    });

    /**
     * The counterpart to the read's overlap handling. `read` may have opened
     * `<root>/x.md` from the request `project/x.md`; a write that only knew the
     * literal reading would create `<root>/project/x.md` — a different file, and
     * the edit would vanish from the one on screen.
     */
    test("saves back to the file the matching read would have opened", async () => {
        const root = await mkdtemp(join(tmpdir(), "loop-stories-"));
        roots.push(root);
        const base = root.split("/").pop()!;
        await writeFile(join(root, "x.md"), "before");

        // Same path shape the read resolves through the overlap fallback.
        const read = await readWorkspaceFile(root, `${base}/x.md`);
        expect(read.ok).toBe(true);

        const result = await writeWorkspaceFile(root, `${base}/x.md`, "after");
        expect(result).toEqual({ ok: true, relativePath: "x.md" });
        expect(await readFile(join(root, "x.md"), "utf8")).toBe("after");
    });

    test("refuses to escape the workspace root", async () => {
        const root = await workspace();
        const result = await writeWorkspaceFile(root, "../escaped.txt", "nope");
        expect(result).toEqual({ ok: false, failure: "resolved_path_outside_root" });
    });

    test("refuses to overwrite a directory", async () => {
        const root = await workspace();
        await mkdir(join(root, "src"), { recursive: true });
        const result = await writeWorkspaceFile(root, "src", "nope");
        expect(result).toEqual({ ok: false, failure: "path_not_file" });
    });

    /** An editor save is not the place to be inventing directory trees. */
    test("refuses a path whose parent directory does not exist", async () => {
        const root = await workspace();
        const result = await writeWorkspaceFile(root, "nowhere/deep/file.txt", "nope");
        expect(result).toEqual({ ok: false, failure: "operation_failed" });
    });

    test("a written file reads back identically", async () => {
        const root = await workspace();
        await writeFile(join(root, "round.md"), "x");
        const contents = "line one\nline two\n\u00e9\u00e0\u4e2d\u6587\n";
        await writeWorkspaceFile(root, "round.md", contents);
        const read = await readWorkspaceFile(root, "round.md");
        expect(read.ok && read.contents).toBe(contents);
    });
});

describe("createDirectory", () => {
    test("creates the whole path, so a project can be added to a folder that is not there", async () => {
        const root = await workspace();
        const target = join(root, "code", "brand-new");

        const result = await createDirectory(target);

        expect(result).toEqual({ ok: true, path: target });
        await writeFile(join(target, "note.md"), "hello");
    });

    test("expands ~, which is a shell convention node would take literally", async () => {
        const result = await createDirectory("~");
        expect(result).toEqual({ ok: true, path: homedir() });
    });

    test("accepts a folder that already exists", async () => {
        // The picker cannot promise the path is still missing by the time this
        // runs, and "it is already there" is what was wanted anyway.
        const root = await workspace();
        expect(await createDirectory(root)).toEqual({ ok: true, path: root });
    });

    test("refuses a relative path rather than creating one somewhere arbitrary", async () => {
        const result = await createDirectory("code/brand-new");
        expect(result).toMatchObject({ ok: false });
    });

    test("reports why it could not create the folder", async () => {
        const root = await workspace();
        await writeFile(join(root, "file"), "not a folder");

        const result = await createDirectory(join(root, "file", "child"));
        expect(result).toMatchObject({ ok: false, failure: expect.stringContaining("ENOTDIR") });
    });
});
