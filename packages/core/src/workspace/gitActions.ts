/**
 * The writes: commit, push, and pull request.
 *
 * `git.ts` is read-only by design — the agent is what writes a repo — but the
 * commit/push/PR buttons in the UI are the user acting on their own repository,
 * not the agent acting on it, and those had no backend at all: every one of
 * them failed with "git.runStackedAction is not supported by loop's desktop
 * app". This module is that backend.
 *
 * It lives in the main process because that is where child processes live, and
 * because a commit must be one uninterruptible sequence: stage, write a
 * message, commit. Splitting it across the IPC boundary would let a renderer
 * reload land between staging and committing, leaving a half-staged index the
 * user never asked for.
 *
 * Everything is spawned with argv arrays and never a shell string, so a branch
 * or a path called `; rm -rf /` stays a name.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

import { baseBranchFor, readGit } from "./git";

/** Long enough for a real push over a slow link, short enough to not hang. */
const PUSH_TIMEOUT_MS = 180_000;
/** Commit runs hooks (linters, test suites), so it gets the most room. */
const COMMIT_TIMEOUT_MS = 300_000;
const PLAIN_TIMEOUT_MS = 30_000;

export type GitStackedAction = "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
export type GitActionPhase = "branch" | "commit" | "push" | "pr";

/**
 * Progress, as the contract's events minus the fields main already knows.
 *
 * `main.ts` stamps `actionId`/`cwd`/`action` on the way out, and the renderer
 * appends the terminal `action_finished`/`action_failed` — it is the one that
 * knows whether the promise resolved.
 */
export type GitActionProgress =
    | { kind: "action_started"; phases: readonly GitActionPhase[] }
    | { kind: "phase_started"; phase: GitActionPhase; label: string }
    | { kind: "hook_started"; hookName: string }
    | {
          kind: "hook_output";
          hookName: string | null;
          stream: "stdout" | "stderr";
          text: string;
      }
    | { kind: "hook_finished"; hookName: string; exitCode: number | null; durationMs: number | null };

export interface GitStackedActionResult {
    readonly action: GitStackedAction;
    readonly branch: { status: "created" | "skipped_not_requested"; name?: string };
    readonly commit: {
        status: "created" | "skipped_no_changes" | "skipped_not_requested";
        commitSha?: string;
        subject?: string;
    };
    readonly push: {
        status: "pushed" | "skipped_not_requested" | "skipped_up_to_date";
        branch?: string;
        upstreamBranch?: string;
        setUpstream?: boolean;
    };
    readonly pr: {
        status: "created" | "opened_existing" | "skipped_not_requested";
        url?: string;
        number?: number;
        baseBranch?: string;
        headBranch?: string;
        title?: string;
    };
}

export interface GitStackedActionInput {
    readonly action: GitStackedAction;
    readonly commitMessage?: string | undefined;
    readonly featureBranch?: boolean | undefined;
    readonly filePaths?: readonly string[] | undefined;
}

export interface GitStackedActionDeps {
    readonly emit: (progress: GitActionProgress) => void;
    /**
     * Writes a commit message for a staged diff. Supplied by `main.ts`, which
     * asks loop for one — this module has no model access and should not.
     * Returning "" is a normal answer and falls back to a plain subject.
     */
    readonly generateMessage?: (input: { diff: string; branch: string | null }) => Promise<string>;
}

interface ExecResult {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/** The environment every git call shares. See `readGit`'s note. */
function gitEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        GIT_PAGER: "cat",
        GIT_OPTIONAL_LOCKS: "0",
        // A write that pops an editor or a credential prompt would hang the main
        // process forever with nothing on screen to explain why.
        GIT_EDITOR: "true",
        GIT_TERMINAL_PROMPT: "0",
    };
}

/**
 * Spawn a command, streaming each output line to `onLine` as it arrives.
 *
 * `spawn` rather than `execFile` because hook output is the point: a pre-commit
 * hook running a test suite for two minutes must show its progress while it
 * runs, and `execFile` only resolves with the whole buffer at the end.
 */
function exec(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
    onLine?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { cwd: options.cwd, env: gitEnv() });
        let stdout = "";
        let stderr = "";
        let settled = false;

        // Partial lines are held back so a line split across two chunks is
        // reported once, whole, rather than as two fragments.
        const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
        const consume = (stream: "stdout" | "stderr", chunk: string) => {
            if (stream === "stdout") stdout += chunk;
            else stderr += chunk;
            if (!onLine) return;
            const combined = pending[stream] + chunk;
            const lines = combined.split("\n");
            pending[stream] = lines.pop() ?? "";
            for (const line of lines) if (line.trim() !== "") onLine(stream, line.trimEnd());
        };
        const flush = () => {
            if (!onLine) return;
            for (const stream of ["stdout", "stderr"] as const) {
                const rest = pending[stream];
                pending[stream] = "";
                if (rest.trim() !== "") onLine(stream, rest.trimEnd());
            }
        };

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            reject(new Error(`${command} ${args[0] ?? ""} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => consume("stdout", chunk));
        child.stderr?.on("data", (chunk: string) => consume("stderr", chunk));

        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // ENOENT here means the binary is missing, which for `gh` is the common
            // case and deserves to say so rather than surfacing a raw errno.
            reject(
                (error as NodeJS.ErrnoException).code === "ENOENT"
                    ? new Error(`${command} is not installed or not on PATH`)
                    : error,
            );
        });
        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            flush();
            resolve({ code, stdout, stderr });
        });
    });
}

/** git, raising the message git actually printed when it fails. */
async function gitOrThrow(
    cwd: string,
    args: readonly string[],
    options: {
        operation: string;
        timeoutMs?: number;
        onLine?: (stream: "stdout" | "stderr", line: string) => void;
    },
): Promise<string> {
    const result = await exec("git", args, { cwd, timeoutMs: options.timeoutMs ?? PLAIN_TIMEOUT_MS }, options.onLine);
    if (result.code !== 0) {
        // git puts the useful half on stderr, but not always (`push` splits across
        // both), so fall back rather than raising an empty message.
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
        throw new Error(`${options.operation} failed: ${detail}`);
    }
    return result.stdout;
}

const CURRENT_BRANCH = ["branch", "--show-current"] as const;

async function currentBranch(cwd: string): Promise<string | null> {
    return (await readGit(cwd, CURRENT_BRANCH))?.trim() || null;
}

/** `refs/remotes/origin/main` → `origin/main`, or null with no upstream. */
async function upstreamOf(cwd: string, branch: string): Promise<string | null> {
    const ref = await readGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{u}`]);
    return ref?.trim() || null;
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
    // --quiet exits 1 when there IS a difference, so a null (non-zero) answer
    // means "something is staged".
    return (await readGit(cwd, ["diff", "--cached", "--quiet"])) === null;
}

/**
 * Slug a commit subject into a branch name.
 *
 * Feature branches are named after what they contain so the branch list stays
 * readable; the timestamp is only a fallback for a message that slugs to
 * nothing (all punctuation, or a non-Latin script).
 */
export function featureBranchName(subject: string, now = new Date()): string {
    const slug = subject
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
    if (slug) return `loop/${slug}`;
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
    return `loop/change-${stamp}`;
}

/**
 * Which pre-commit hook would run, if any.
 *
 * Only reported when one genuinely exists and is executable, so the UI's
 * "Running pre-commit..." line never appears for a repo that has no hooks —
 * claiming a hook ran when none did is worse than staying quiet.
 */
async function preCommitHook(cwd: string): Promise<string | null> {
    const configured = (await readGit(cwd, ["config", "--get", "core.hooksPath"]))?.trim();
    const gitDir = (await readGit(cwd, ["rev-parse", "--git-dir"]))?.trim() || ".git";
    const dir = configured || join(gitDir, "hooks");
    // `git rev-parse --git-dir` is relative to cwd unless it is absolute.
    const path = join(dir.startsWith("/") ? dir : join(cwd, dir), "pre-commit");
    try {
        await access(path, constants.X_OK);
        return "pre-commit";
    } catch {
        return null;
    }
}

/** The phases this action will run, in order — the UI draws a stage per entry. */
export function phasesFor(input: GitStackedActionInput, hasChanges: boolean): GitActionPhase[] {
    const { action } = input;
    if (action === "push") return ["push"];
    if (action === "create_pr") return ["pr"];

    const commits = action === "commit" || hasChanges;
    return [
        ...(input.featureBranch ? (["branch"] as const) : []),
        ...(commits ? (["commit"] as const) : []),
        ...(action === "commit_push" || action === "commit_push_pr" ? (["push"] as const) : []),
        ...(action === "commit_push_pr" ? (["pr"] as const) : []),
    ];
}

interface PrJson {
    number?: number;
    url?: string;
    title?: string;
    state?: string;
    baseRefName?: string;
    headRefName?: string;
}

/** The open PR for `branch`, or null. `gh` exits non-zero when there is none. */
async function existingPr(cwd: string, branch: string): Promise<PrJson | null> {
    const result = await exec(
        "gh",
        ["pr", "view", branch, "--json", "number,url,title,state,baseRefName,headRefName"],
        { cwd, timeoutMs: PLAIN_TIMEOUT_MS },
    );
    if (result.code !== 0) return null;
    try {
        const parsed = JSON.parse(result.stdout) as PrJson;
        return parsed.state === "OPEN" ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Run a stacked git action.
 *
 * Phases run in order and each one's outcome is recorded rather than inferred,
 * so the caller can tell "committed nothing because nothing changed" from
 * "never asked to commit" — the UI's toast wording depends on that difference.
 */
export async function runStackedAction(
    cwd: string,
    input: GitStackedActionInput,
    deps: GitStackedActionDeps,
): Promise<GitStackedActionResult> {
    const inside = await readGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside?.trim() !== "true") throw new Error(`${cwd} is not a git repository`);

    const { emit } = deps;
    const wantsCommit =
        input.action === "commit" || input.action === "commit_push" || input.action === "commit_push_pr";
    const wantsPush = input.action === "push" || input.action === "commit_push" || input.action === "commit_push_pr";
    const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";

    const result: {
        branch: GitStackedActionResult["branch"];
        commit: GitStackedActionResult["commit"];
        push: GitStackedActionResult["push"];
        pr: GitStackedActionResult["pr"];
    } = {
        branch: { status: "skipped_not_requested" },
        commit: { status: "skipped_not_requested" },
        push: { status: "skipped_not_requested" },
        pr: { status: "skipped_not_requested" },
    };

    // Staging first: what is staged decides whether there is a commit to make,
    // and the staged diff is what a generated message describes.
    if (wantsCommit) {
        if (input.filePaths?.length) {
            // `--` so a path that looks like a flag stays a path. `-A` on a pathspec
            // also picks up deletions, which plain `add` would miss.
            await gitOrThrow(cwd, ["add", "-A", "--", ...input.filePaths], { operation: "git add" });
        } else {
            await gitOrThrow(cwd, ["add", "-A"], { operation: "git add" });
        }
    }

    const staged = wantsCommit ? await hasStagedChanges(cwd) : false;
    emit({ kind: "action_started", phases: phasesFor(input, staged) });

    if (wantsCommit && !staged) {
        // Nothing to commit is not a failure: `commit_push` on an already-committed
        // branch is a normal way to reach the push.
        result.commit = { status: "skipped_no_changes" };
    } else if (wantsCommit) {
        let subject = input.commitMessage?.trim() ?? "";
        const branchNow = await currentBranch(cwd);

        if (!subject && deps.generateMessage) {
            emit({ kind: "phase_started", phase: "commit", label: "Generating commit message..." });
            const diff = (await readGit(cwd, ["diff", "--cached"])) ?? "";
            try {
                subject = (await deps.generateMessage({ diff, branch: branchNow })).trim();
            } catch {
                // A summarizer outage must not cost the user their staged commit.
                subject = "";
            }
        }
        if (!subject) {
            const count = (await readGit(cwd, ["diff", "--cached", "--name-only"]))?.trim().split("\n").length;
            subject = count === 1 ? "Update 1 file" : `Update ${count ?? 0} files`;
        }

        // The feature branch is created after the message so it can be named for
        // it, but before the commit so the commit lands on the new branch.
        if (input.featureBranch) {
            emit({ kind: "phase_started", phase: "branch", label: "Preparing feature ref..." });
            const name = featureBranchName(subject);
            await gitOrThrow(cwd, ["switch", "-c", name], { operation: "git switch -c" });
            result.branch = { status: "created", name };
        }

        emit({ kind: "phase_started", phase: "commit", label: "Committing..." });
        const hookName = await preCommitHook(cwd);
        const startedAt = Date.now();
        if (hookName) emit({ kind: "hook_started", hookName });
        try {
            await gitOrThrow(cwd, ["commit", "-m", subject], {
                operation: "git commit",
                timeoutMs: COMMIT_TIMEOUT_MS,
                onLine: (stream, text) => emit({ kind: "hook_output", hookName, stream, text }),
            });
        } finally {
            if (hookName) {
                emit({
                    kind: "hook_finished",
                    hookName,
                    exitCode: null,
                    durationMs: Date.now() - startedAt,
                });
            }
        }
        const sha = (await readGit(cwd, ["rev-parse", "HEAD"]))?.trim();
        result.commit = {
            status: "created",
            subject,
            ...(sha ? { commitSha: sha } : {}),
        };
    }

    if (wantsPush) {
        const branch = await currentBranch(cwd);
        if (!branch) throw new Error("cannot push from a detached HEAD");
        const upstream = await upstreamOf(cwd, branch);

        if (upstream) {
            const ahead = (await readGit(cwd, ["rev-list", "--count", `${upstream}..${branch}`]))?.trim();
            if (ahead === "0") result.push = { status: "skipped_up_to_date", branch };
        }

        if (result.push.status !== "skipped_up_to_date") {
            emit({
                kind: "phase_started",
                phase: "push",
                label: upstream ? `Pushing to ${upstream}...` : "Pushing...",
            });
            const args = upstream ? ["push"] : ["push", "--set-upstream", "origin", branch];
            await gitOrThrow(cwd, args, {
                operation: "git push",
                timeoutMs: PUSH_TIMEOUT_MS,
                // Push writes its progress to stderr; surfacing it keeps the toast
                // alive during a slow upload instead of looking wedged.
                onLine: (stream, text) => emit({ kind: "hook_output", hookName: null, stream, text }),
            });
            result.push = {
                status: "pushed",
                branch,
                ...(upstream ? { upstreamBranch: upstream } : { setUpstream: true }),
            };
        }
    }

    if (wantsPr) {
        const branch = await currentBranch(cwd);
        if (!branch) throw new Error("cannot open a pull request from a detached HEAD");

        emit({ kind: "phase_started", phase: "pr", label: "Preparing pull request..." });
        const already = await existingPr(cwd, branch);
        if (already) {
            result.pr = {
                status: "opened_existing",
                ...(already.url ? { url: already.url } : {}),
                ...(already.number ? { number: already.number } : {}),
                ...(already.title ? { title: already.title } : {}),
                ...(already.baseRefName ? { baseBranch: already.baseRefName } : {}),
                ...(already.headRefName ? { headBranch: already.headRefName } : {}),
            };
        } else {
            // `create_pr` on its own still has to get the branch to the remote, or
            // there is nothing for the PR to be opened against.
            if (!(await upstreamOf(cwd, branch))) {
                emit({ kind: "phase_started", phase: "push", label: "Pushing..." });
                await gitOrThrow(cwd, ["push", "--set-upstream", "origin", branch], {
                    operation: "git push",
                    timeoutMs: PUSH_TIMEOUT_MS,
                });
                if (result.push.status === "skipped_not_requested") {
                    result.push = { status: "pushed", branch, setUpstream: true };
                }
            }

            const base = (await baseBranchFor(cwd, branch))?.replace(/^origin\//, "");
            emit({ kind: "phase_started", phase: "pr", label: "Creating pull request..." });
            const created = await exec("gh", ["pr", "create", "--fill", ...(base ? ["--base", base] : [])], {
                cwd,
                timeoutMs: PUSH_TIMEOUT_MS,
            });
            if (created.code !== 0) {
                const detail = created.stderr.trim() || created.stdout.trim() || `exit ${created.code}`;
                throw new Error(`gh pr create failed: ${detail}`);
            }
            // `gh` prints the URL on stdout; re-reading it gives the number too.
            const opened = await existingPr(cwd, branch);
            const url = created.stdout.trim().split("\n").at(-1)?.trim();
            result.pr = {
                status: "created",
                ...((opened?.url ?? url) ? { url: opened?.url ?? url ?? "" } : {}),
                ...(opened?.number ? { number: opened.number } : {}),
                ...(opened?.title ? { title: opened.title } : {}),
                ...(base ? { baseBranch: base } : {}),
                headBranch: branch,
            };
        }
    }

    return { action: input.action, ...result };
}
