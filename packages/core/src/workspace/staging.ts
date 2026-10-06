/**
 * Writes against the index: stage, unstage, discard.
 *
 * Everything in `git.ts` is read-only by design. These are the first operations
 * that change a repository from the panel rather than through the agent, so
 * they are kept apart from the readers and each one is a single, named intent
 * rather than a general "run git" escape hatch.
 *
 * **Partial staging does not build a patch.** The obvious approach —
 * synthesise a diff for the selected hunk and pipe it to `git apply --cached` —
 * drags in every patch-generation edge case there is: recomputing `@@` headers
 * after dropping lines, preserving context, `\ No newline at end of file`, CRLF
 * files. VS Code's git extension sidesteps all of it, and this follows suit:
 * compute what the file *should* look like, write that blob into the object
 * database, and point the index entry at it. There is no patch, so there is
 * nothing for a patch to get wrong.
 */
import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { readGit, withGitSlot } from "./git";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** The mode git uses for an ordinary non-executable file. */
const REGULAR_FILE_MODE = "100644";

/**
 * Run a git command that is expected to succeed, and say why if it does not.
 *
 * The readers collapse failure into `null` because "no upstream" is an answer.
 * A write is different: a stage that silently did nothing would leave the panel
 * showing a state the repository is not in, so the error has to travel.
 */
async function write(cwd: string, args: readonly string[], input?: string): Promise<string> {
    try {
        const { stdout } = await withGitSlot(() => {
            const child = run("git", [...args], {
                cwd,
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: MAX_BUFFER_BYTES,
                env: { ...process.env, GIT_PAGER: "cat" },
            });
            if (input !== undefined) {
                child.child.stdin?.end(input);
            }
            return child;
        });
        return stdout;
    } catch (error) {
        const message =
            error instanceof Error && "stderr" in error && typeof error.stderr === "string"
                ? error.stderr.trim() || error.message
                : error instanceof Error
                  ? error.message
                  : String(error);
        throw new Error(`git ${args[0]} failed: ${message}`);
    }
}

/**
 * Whether the repository has a commit yet.
 *
 * A repository with no HEAD is not an edge case worth ignoring — it is every
 * project between `git init` and its first commit, and several index
 * operations are spelled differently there because there is no tree to compare
 * against or reset to.
 */
async function hasHead(cwd: string): Promise<boolean> {
    const head = await readGit(cwd, ["rev-parse", "--verify", "HEAD"]);
    return head !== null && head.trim() !== "";
}

/** Stage whole files, including deletions and untracked files. */
export async function stageFiles(cwd: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    // `--all` rather than plain `add` so a staged DELETION is recorded; `git add`
    // on a path that no longer exists is an error otherwise.
    await write(cwd, ["add", "--all", "--", ...paths]);
}

/**
 * Take files back out of the index, leaving the working tree alone.
 *
 * Two spellings because `restore --staged` resets the entry to HEAD, and with
 * no HEAD there is nothing to reset to — the entry has to be removed from the
 * index outright. Getting this wrong is invisible until someone stages a file
 * in a fresh repository and cannot unstage it.
 */
export async function unstageFiles(cwd: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    if (await hasHead(cwd)) {
        await write(cwd, ["restore", "--staged", "--", ...paths]);
        return;
    }
    await write(cwd, ["rm", "--cached", "-r", "--", ...paths]);
}

/**
 * Throw away changes in the working tree.
 *
 * Destructive and unrecoverable — git keeps no copy of a discarded working-tree
 * edit — so the caller is expected to have confirmed. Untracked files are not
 * something `git restore` can address (there is no index entry to restore
 * from), so they are deleted directly.
 */
export async function discardChanges(
    cwd: string,
    input: { readonly tracked: readonly string[]; readonly untracked: readonly string[] },
): Promise<void> {
    if (input.tracked.length > 0) {
        // Both sides: the file should come back as it is in the index, and the
        // index entry itself as it is in HEAD.
        await write(cwd, ["checkout", "HEAD", "--", ...input.tracked]).catch(async () => {
            // No HEAD yet — the best available "undo" is the index.
            await write(cwd, ["restore", "--", ...input.tracked]);
        });
    }
    for (const path of input.untracked) {
        await unlink(join(cwd, path)).catch(() => undefined);
    }
}

/**
 * Put exact file content into the index, leaving the working tree untouched.
 *
 * This is the primitive behind staging a hunk or a selection of lines: the
 * caller computes what the staged version of the file should be and hands it
 * over. Two steps, exactly as VS Code's git extension does it —
 *
 *   git hash-object --stdin -w --path <path>   ->  write a blob, get its sha
 *   git update-index --cacheinfo <mode>,<sha>,<path>
 *
 * `--path` is not decoration: it makes `hash-object` apply the filters that
 * path would be subject to — `.gitattributes`, `core.autocrlf`, clean filters —
 * so a CRLF file stages the way `git add` would stage it rather than acquiring
 * spurious line-ending changes.
 *
 * The mode is read from the existing entry so an executable file does not
 * quietly lose its bit; a path git has never seen is a new file, which takes
 * the regular mode and has to be `--add`ed rather than updated.
 */
export async function stageContent(cwd: string, path: string, content: string): Promise<void> {
    const sha = (await write(cwd, ["hash-object", "--stdin", "-w", "--path", path], content)).trim();
    if (sha === "") throw new Error(`git hash-object produced no object for ${path}`);

    const mode = await modeOf(cwd, path);
    const args = ["update-index", "--cacheinfo", `${mode.mode},${sha},${path}`];
    if (mode.isNew) args.splice(1, 0, "--add");
    await write(cwd, args);
}

/**
 * The mode git already records for this path, and whether it knows it at all.
 *
 * `ls-files --stage` reports the INDEX entry, which is the one being replaced;
 * falling back to HEAD covers a file that is tracked but not currently staged.
 * Anything else is new to the index and needs `--add`.
 */
async function modeOf(cwd: string, path: string): Promise<{ mode: string; isNew: boolean }> {
    const indexed = await readGit(cwd, ["ls-files", "--stage", "--", path]);
    const fromIndex = indexed?.trim().split(/\s+/)[0];
    if (fromIndex !== undefined && fromIndex !== "") return { mode: fromIndex, isNew: false };

    const head = await readGit(cwd, ["ls-tree", "HEAD", "--", path]);
    const fromHead = head?.trim().split(/\s+/)[0];
    if (fromHead !== undefined && fromHead !== "") return { mode: fromHead, isNew: false };

    return { mode: REGULAR_FILE_MODE, isNew: true };
}

/**
 * A file's content at a revision, for computing a partial stage.
 *
 * Staging a hunk needs two versions to diff: what the index holds (`:path`) and
 * what is on disk. Unstaging one needs HEAD and the index. Rather than a
 * general "run git show", the revision is restricted to the three that mean
 * something here — an arbitrary revspec from the renderer would be a way to
 * read anything in the repository's history through a path parameter.
 *
 * Null when the file does not exist at that revision, which is ordinary: a new
 * file has no HEAD version.
 */
export async function fileAtRevision(cwd: string, revision: "HEAD" | "index", path: string): Promise<string | null> {
    const spec = revision === "index" ? `:${path}` : `HEAD:${path}`;
    return readGit(cwd, ["show", spec]);
}

/**
 * The three sides of a conflict, read out of the index stages.
 *
 * A merge leaves the conflicting file recorded three times: stage 1 is the
 * common ancestor, 2 is ours, 3 is theirs. That is exactly the input a
 * three-way merge view needs, and it is available without re-running the merge
 * or parsing the conflict markers out of the working-tree file.
 *
 * Any side can legitimately be absent — "added by them" has no base and no
 * ours — so each is null rather than empty when the stage does not exist.
 */
export async function conflictStages(
    cwd: string,
    path: string,
): Promise<{ base: string | null; ours: string | null; theirs: string | null }> {
    const read = async (stage: 1 | 2 | 3): Promise<string | null> => readGit(cwd, ["show", `:${stage}:${path}`]);
    const [base, ours, theirs] = await Promise.all([read(1), read(2), read(3)]);
    return { base, ours, theirs };
}
