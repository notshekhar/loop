/**
 * Git, by shelling out.
 *
 * Third capability the shell provides and loop's RPC does not. Everything here
 * is read-only on purpose: the app shows you branches and what has changed,
 * and the agent is the thing that writes. A `git` that can commit and push
 * from the renderer is a much bigger decision than a status panel.
 *
 * `git` is spawned with argv arrays and never a shell string, so a branch
 * called `; rm -rf /` is a branch name rather than a command.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  type ConflictKind,
  type StatusCode,
  isStaged,
  isUnstaged,
  parsePorcelainV2,
} from "./porcelain.js";

const run = promisify(execFile);

/** Bounded so a pathological repo cannot wedge the main process. */
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * How many `git` processes this module may have in flight at once.
 *
 * Not a politeness limit — a latency one. `uv_spawn` is a BLOCKING syscall on
 * the calling thread, and the calling thread here is the one running loop's
 * core: the agent turn, its tool calls, the session writes, every PTY byte and
 * every IPC reply. A `Promise.all` over N spawns is therefore N fork/execs
 * back to back with no yield in between, and the whole window is dead air for
 * the running thread.
 *
 * That is exactly what the fan-outs below used to do — `untrackedPatch` up to
 * `MAX_UNTRACKED_FILES`, `workspaceStatus` and `workspaceDiffPreview` up to
 * `WORKSPACE_REPO_LIMIT` repositories times ~6 commands each. Opening the diff
 * panel mid-turn stalled the agent, which is what "the session gets stuck"
 * was.
 *
 * MEASURED (10-core M-series, 200 spawns of `git --version`):
 *
 *   unbounded  wall 229ms   worst event-loop stall 217ms
 *   pool of 4  wall 287ms   worst event-loop stall   3ms
 *   pool of 8  wall 200ms   worst event-loop stall   3ms
 *   pool of 16 wall 184ms   worst event-loop stall   8ms
 *   pool of 32 wall 203ms   worst event-loop stall  27ms
 *
 * Eight is where wall-clock bottoms out — the bounded run is FASTER than the
 * unbounded one, because 200 simultaneous forks contend more than they
 * parallelise. Past 12 the stall grows again and buys nothing. So this costs
 * no throughput; it only stops the burst from being one unbroken block.
 */
export const MAX_CONCURRENT_GIT = 8;

let activeGitProcesses = 0;
const waitingForGitSlot: Array<() => void> = [];

/**
 * Run `work` with a spawn slot held.
 *
 * A release HANDS ITS SLOT to the next waiter rather than decrementing and
 * signalling. Decrementing first opens a window — the waiter only resumes on a
 * later microtask, and a caller arriving in between sees a count below the
 * limit, takes the slot, and then the waiter increments on top of it. The pool
 * ratchets past its own ceiling, one process per contended release, which is
 * precisely the burst this exists to prevent.
 *
 * Transferring also keeps the queue honestly FIFO: while anyone is waiting the
 * count is pinned at the limit, so a newcomer always queues behind them
 * instead of barging a slot a waiter was already promised.
 *
 * The release sits in a `finally` so a throwing or timing-out command cannot
 * leak a slot and shrink the pool for the rest of the session.
 */
export async function withGitSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeGitProcesses >= MAX_CONCURRENT_GIT) {
    await new Promise<void>((resolve) => waitingForGitSlot.push(resolve));
    // The slot came with the wakeup; the count already counts us.
  } else {
    activeGitProcesses += 1;
  }
  try {
    return await work();
  } finally {
    const next = waitingForGitSlot.shift();
    if (next) next();
    else activeGitProcesses -= 1;
  }
}

/**
 * Read a git command's stdout, or null if it failed.
 *
 * Exported for `gitActions.ts`, which owns the writes: the two modules must
 * agree on the environment (`GIT_PAGER`, `GIT_OPTIONAL_LOCKS`) or a write would
 * see a different repo view than the panel showing it.
 */
export async function readGit(cwd: string, args: readonly string[]): Promise<string | null> {
  return git(cwd, args);
}

/**
 * How many `git` processes this module has spawned.
 *
 * Exported for the tests that pin the cost of the workspace fan-outs: the
 * difference between two invocations per repository and seven is invisible on
 * one repository and is the whole story on fifty.
 */
let gitInvocations = 0;
export function gitInvocationCount(): number {
  return gitInvocations;
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  gitInvocations += 1;
  try {
    const { stdout } = await withGitSlot(() =>
      run("git", [...args], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        // A pager would never return; git turns it off when not a TTY, but an
        // explicit -c is the only guarantee across user configs.
        env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
      }),
    );
    return stdout;
  } catch {
    // A non-zero exit is an answer, not a crash: "not a repo", "no upstream",
    // "no such ref" all arrive this way and each has a sensible empty result.
    return null;
  }
}

/**
 * A folder holding repositories, which is not itself one.
 *
 * A very common way to work: `~/work` with a dozen micro-services under it,
 * each its own repository and the parent deliberately not. Opened as a
 * project, every git-shaped surface reported "not a repository" and the diff
 * panel was simply unavailable — the changes were all one level down, and
 * nothing looked there.
 *
 * Two levels deep, because services are often grouped (`~/work/payments/api`),
 * and no deeper: past that the walk costs more than it finds. A directory that
 * IS a repository is never descended into — its submodules belong to it.
 */
const WORKSPACE_REPO_MAX_DEPTH = 2;
const WORKSPACE_REPO_LIMIT = 50;
/** Never worth a stat: none of these hold a project's repositories. */
const NON_REPO_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
]);

async function isRepositoryRoot(directory: string): Promise<boolean> {
  try {
    // A worktree's `.git` is a file, not a directory, so `stat` alone answers.
    await stat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Repositories nested under `root`, as paths relative to it.
 *
 * Sorted so the panel's ordering is stable between reads — an unsorted
 * `readdir` reshuffles the diff on every poll.
 */
export async function workspaceRepositories(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > WORKSPACE_REPO_MAX_DEPTH || found.length >= WORKSPACE_REPO_LIMIT) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (found.length >= WORKSPACE_REPO_LIMIT) return;
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      if (child.name.startsWith(".") || NON_REPO_DIRECTORIES.has(child.name)) continue;
      const absolute = join(directory, child.name);
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (await isRepositoryRoot(absolute)) {
        found.push(relative);
        continue;
      }
      await walk(absolute, relative, depth + 1);
    }
  };
  await walk(root, "", 1);
  return found.sort((a, b) => a.localeCompare(b));
}

export interface GitRef {
  readonly name: string;
  readonly isRemote: boolean;
  readonly remoteName?: string;
  readonly current: boolean;
  readonly isDefault: boolean;
  readonly worktreePath: string | null;
}

export interface GitRefs {
  readonly refs: readonly GitRef[];
  readonly isRepo: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly totalCount: number;
}

/** The branch the remote's HEAD points at, else the conventional fallbacks. */
async function defaultBranch(cwd: string, names: ReadonlySet<string>): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const fromRemote = head?.trim().replace(/^origin\//, "");
  if (fromRemote) return fromRemote;
  for (const candidate of ["main", "master"]) if (names.has(candidate)) return candidate;
  return null;
}

export async function listRefs(cwd: string): Promise<GitRefs> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") {
    return { refs: [], isRepo: false, hasPrimaryRemote: false, totalCount: 0 };
  }

  const [branchOutput, remoteOutput, worktreeOutput] = await Promise.all([
    // %(HEAD) is "*" for the checked-out branch — cheaper and more reliable
    // than a second rev-parse, and correct in a detached worktree.
    git(cwd, [
      "for-each-ref",
      "--format=%(HEAD)%09%(refname:short)%09%(refname:rstrip=-2)",
      "refs/heads",
      "refs/remotes",
    ]),
    git(cwd, ["remote"]),
    git(cwd, ["worktree", "list", "--porcelain"]),
  ]);

  const worktreeByBranch = new Map<string, string>();
  let currentWorktree: string | null = null;
  for (const line of (worktreeOutput ?? "").split("\n")) {
    if (line.startsWith("worktree ")) currentWorktree = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && currentWorktree) {
      worktreeByBranch.set(line.slice("branch refs/heads/".length).trim(), currentWorktree);
    }
  }

  const rows = (branchOutput ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [head = "", name = "", kind = ""] = line.split("\t");
      return { current: head === "*", name, isRemote: kind === "refs/remotes" };
    })
    // origin/HEAD is a symbolic alias, not a branch anyone means to check out.
    .filter((row) => row.name !== "" && !row.name.endsWith("/HEAD"));

  const localNames = new Set(rows.filter((row) => !row.isRemote).map((row) => row.name));
  const fallbackDefault = await defaultBranch(cwd, localNames);

  const refs: GitRef[] = rows.map((row) => {
    const remoteName = row.isRemote ? row.name.slice(0, row.name.indexOf("/")) : undefined;
    return {
      name: row.name,
      isRemote: row.isRemote,
      ...(remoteName === undefined ? {} : { remoteName }),
      current: row.current,
      isDefault: !row.isRemote && row.name === fallbackDefault,
      worktreePath: worktreeByBranch.get(row.name) ?? null,
    };
  });

  return {
    refs,
    isRepo: true,
    hasPrimaryRemote: (remoteOutput ?? "").trim() !== "",
    totalCount: refs.length,
  };
}

/**
 * One changed file, with the index and the working tree kept apart.
 *
 * `workingTree.files` below answers "what has changed since the last commit"
 * and fuses the two, which is all the old flat list ever needed. Staging needs
 * them separate — a file can be modified in the index AND modified again on
 * disk, and that file belongs in both groups of the panel showing different
 * diffs. Line counts are per side for the same reason.
 */
export interface GitFileChange {
  readonly path: string;
  /** Where a rename or copy came from. */
  readonly originalPath?: string;
  /** X — the index against HEAD. Null when the index matches HEAD. */
  readonly indexStatus: StatusCode | null;
  /** Y — the working tree against the index. Null when they match. */
  readonly worktreeStatus: StatusCode | null;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  /** Present iff the file is unmerged; such a file is in neither group. */
  readonly conflict?: ConflictKind;
  readonly stagedInsertions: number;
  readonly stagedDeletions: number;
  readonly unstagedInsertions: number;
  readonly unstagedDeletions: number;
}

export interface GitStatus {
  readonly isRepo: boolean;
  /** Reported a repo only because it CONTAINS repositories — see
   * `workspaceStatus`. Absent on a real single repository. */
  readonly isWorkspaceRoot?: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly isDefaultRef: boolean;
  readonly refName: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly workingTree: {
    readonly files: ReadonlyArray<{ path: string; insertions: number; deletions: number }>;
    readonly insertions: number;
    readonly deletions: number;
  };
  /**
   * The same changes, split by index vs working tree.
   *
   * Alongside `workingTree` rather than replacing it: the existing panel reads
   * that shape, and a rewrite of the data and the UI in one step would have
   * nothing left working to compare against. Empty on a workspace root, where
   * staging spans no single repository and has no meaning.
   */
  readonly changes: ReadonlyArray<GitFileChange>;
  /** A merge, rebase or cherry-pick is in progress and has conflicts. */
  readonly hasConflicts: boolean;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly hasUpstream: boolean;
  readonly aheadCount: number;
  readonly behindCount: number;
}

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  changes: [],
  hasConflicts: false,
  stagedCount: 0,
  unstagedCount: 0,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
};

/**
 * One status for a folder full of repositories.
 *
 * Reported as a repo so the panels that read this — the diff surface above all
 * — become available, with every changed path qualified by the repository it
 * came from. The single-repo fields stay off deliberately: there is no one
 * branch, no one remote, and no upstream to be ahead of, and claiming
 * otherwise would offer a push that has no repository to run in.
 */
async function workspaceStatus(cwd: string, repositories: readonly string[]): Promise<GitStatus> {
  const perRepo = await Promise.all(
    repositories.map(async (repository) => ({
      repository,
      // Two git calls rather than seven; this needs branch, paths and counts,
      // which is exactly what a summary carries. See `repositorySummary`.
      summary: await repositorySummary(join(cwd, repository)).catch(() => null),
    })),
  );

  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  let insertions = 0;
  let deletions = 0;
  const branches = new Set<string>();
  for (const { repository, summary } of perRepo) {
    if (!summary) continue;
    if (summary.branch) branches.add(summary.branch);
    insertions += summary.insertions;
    deletions += summary.deletions;
    for (const file of summary.files) {
      files.push({ ...file, path: `${repository}/${file.path}` });
    }
  }

  return {
    isRepo: true,
    // Says WHY isRepo is true, which the caller cannot otherwise tell: this
    // folder has no branch of its own, and without the flag a reader takes
    // `refName: null` for a detached HEAD and offers to check a branch out.
    isWorkspaceRoot: true,
    /**
     * No staging across a folder of repositories.
     *
     * `changes` is deliberately empty here rather than a merge of the children:
     * staging is an operation on one index, and there is no such thing as
     * staging a file in repository A and one in repository B together. The
     * panel drills into a single repository for that, which is where a real
     * index exists. `workingTree` above still carries the qualified paths, so
     * the read-only overview is unchanged.
     */
    changes: [],
    hasConflicts: false,
    stagedCount: 0,
    unstagedCount: 0,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    // Only when every repository agrees; otherwise there is no honest name.
    refName: branches.size === 1 ? [...branches][0]! : null,
    hasWorkingTreeChanges: files.length > 0,
    workingTree: { files, insertions, deletions },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
  };
}

/**
 * Just enough about a repository to draw one row of a list.
 *
 * The folder-of-repositories view needs a branch name, how many files changed
 * and the line counts — and nothing else. Going through `status` for that
 * costs seven `git` invocations per repository, most of them answering
 * questions the row never asks: the remote, the upstream, the default branch,
 * whether this ref is it.
 *
 * This is two. `--branch` makes the porcelain read report the branch as well as
 * the files, so the only other command is the numstat that carries the line
 * counts. On a folder of fifty checkouts that is a hundred processes instead of
 * three hundred and fifty, and since `uv_spawn` blocks the thread that calls
 * it, the difference is felt as the folder opening rather than hanging.
 */
export async function repositorySummary(cwd: string): Promise<{
  branch: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{ path: string; insertions: number; deletions: number }>;
}> {
  const [porcelain, numstat] = await Promise.all([
    /**
     * `normal`, not `all` — git's own default, and the difference between a
     * folder that opens and one that appears to hang.
     *
     * `all` makes git enumerate every untracked FILE, so a repository holding a
     * large untracked directory — a `node_modules` nobody ignored, a build
     * output — is walked in its entirety to answer a question the row does not
     * ask. MEASURED on one such repository in a real folder: 533ms against
     * 178ms. `normal` reports that directory as a single entry, which is all a
     * count of changed things needs, and the panel that does need every file
     * asks for it per repository where the cost is paid once.
     */
    git(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"]),
    git(cwd, ["diff", "--numstat", "HEAD"]),
  ]);

  // `# branch.head <name>` — or `(detached)`, which is not a branch to show.
  const head = /# branch\.head (.+?)\0/.exec(porcelain ?? "")?.[1]?.trim();
  const branch = head === undefined || head === "" || head === "(detached)" ? null : head;

  const counts = parseNumstat(numstat ?? "");
  const files = parsePorcelainV2(porcelain ?? "")
    .filter((entry) => !entry.ignored)
    .map((entry) => ({
      path: entry.path,
      insertions: counts.get(entry.path)?.insertions ?? 0,
      deletions: counts.get(entry.path)?.deletions ?? 0,
    }));

  return {
    branch,
    filesChanged: files.length,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files,
  };
}

export async function status(
  cwd: string,
  options: {
    /**
     * Read the index-aware `changes` list, which costs three more `git`
     * invocations per repository — porcelain plus a numstat per side.
     *
     * On by default, because a single repository is what the source-control
     * panel reads. The workspace paths turn it OFF: they call this once per
     * repository to build a list of names and counts, and with fifty
     * checkouts those three extra spawns each are a hundred and fifty
     * processes whose answer is thrown away. `uv_spawn` blocks the calling
     * thread, so that is not free — it is the difference between a folder
     * opening promptly and appearing to hang.
     */
    readonly indexAware?: boolean;
  } = {},
): Promise<GitStatus> {
  const indexAware = options.indexAware ?? true;
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") {
    const repositories = await workspaceRepositories(cwd);
    return repositories.length > 0 ? workspaceStatus(cwd, repositories) : EMPTY_STATUS;
  }

  const [branch, remotes, numstat, untracked, upstream, porcelain, stagedStat, unstagedStat] =
    await Promise.all([
      git(cwd, ["branch", "--show-current"]),
      git(cwd, ["remote"]),
      // HEAD covers staged and unstaged together, which is what "what has
      // changed since the last commit" means to someone reading the panel.
      git(cwd, ["diff", "--numstat", "HEAD"]),
      git(cwd, ["ls-files", "--others", "--exclude-standard"]),
      git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
      // The index-aware view. Porcelain v2 because v1's rename field is
      // ambiguous and the human-readable output is not a stable interface.
      indexAware
        ? git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])
        : Promise.resolve(null),
      indexAware ? git(cwd, ["diff", "--numstat", "--cached"]) : Promise.resolve(null),
      indexAware ? git(cwd, ["diff", "--numstat"]) : Promise.resolve(null),
    ]);

  const files: Array<{ path: string; insertions: number; deletions: number }> = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of (numstat ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const [added = "", removed = "", path = ""] = line.split("\t");
    if (path === "") continue;
    // "-" is git's marker for a binary file; it has no line counts.
    const plus = added === "-" ? 0 : Number.parseInt(added, 10) || 0;
    const minus = removed === "-" ? 0 : Number.parseInt(removed, 10) || 0;
    insertions += plus;
    deletions += minus;
    files.push({ path, insertions: plus, deletions: minus });
  }
  for (const path of (untracked ?? "").split("\n")) {
    if (path.trim() !== "") files.push({ path, insertions: 0, deletions: 0 });
  }

  const [behindRaw = "0", aheadRaw = "0"] = (upstream ?? "").trim().split(/\s+/);
  const refName = branch?.trim() || null;
  const localNames = refName ? new Set([refName]) : new Set<string>();

  const changes = buildChanges(porcelain ?? "", stagedStat ?? "", unstagedStat ?? "");

  return {
    isRepo: true,
    hasPrimaryRemote: (remotes ?? "").trim() !== "",
    isDefaultRef: refName !== null && refName === (await defaultBranch(cwd, localNames)),
    refName,
    hasWorkingTreeChanges: files.length > 0,
    workingTree: { files, insertions, deletions },
    changes,
    hasConflicts: changes.some((change) => change.conflict !== undefined),
    stagedCount: changes.filter((change) => change.staged).length,
    unstagedCount: changes.filter((change) => change.unstaged).length,
    // `upstream` is null when @{upstream} does not resolve — no tracking branch.
    hasUpstream: upstream !== null,
    aheadCount: Number.parseInt(aheadRaw, 10) || 0,
    behindCount: Number.parseInt(behindRaw, 10) || 0,
  };
}

/**
 * Join the porcelain statuses to the per-side line counts.
 *
 * Two numstats rather than one: `--cached` measures the index against HEAD and
 * a bare `diff` measures the working tree against the index, and those are the
 * two numbers the panel's two groups need. `diff HEAD` — what the flat list
 * used — is neither of them, and for a file that is staged and then edited
 * again it equals neither side.
 *
 * Untracked files appear in no diff at all, so they carry no counts here; the
 * panel shows them as new rather than as a line total.
 */
function buildChanges(porcelain: string, stagedStat: string, unstagedStat: string): GitFileChange[] {
  const staged = parseNumstat(stagedStat);
  const unstaged = parseNumstat(unstagedStat);

  return parsePorcelainV2(porcelain)
    // Ignored files are reported so callers can reason about them, never listed
    // as changes — a panel full of node_modules would be useless.
    .filter((entry) => !entry.ignored)
    .map((entry) => {
      // Renames are counted under the new path by `--numstat` too, so the
      // lookup key is the same one porcelain reports.
      const stagedCounts = staged.get(entry.path) ?? { insertions: 0, deletions: 0 };
      const unstagedCounts = unstaged.get(entry.path) ?? { insertions: 0, deletions: 0 };
      return {
        path: entry.path,
        ...(entry.originalPath === undefined ? {} : { originalPath: entry.originalPath }),
        indexStatus: entry.indexStatus,
        worktreeStatus: entry.worktreeStatus,
        staged: isStaged(entry),
        unstaged: isUnstaged(entry),
        untracked: entry.untracked,
        ...(entry.conflict === undefined ? {} : { conflict: entry.conflict }),
        stagedInsertions: stagedCounts.insertions,
        stagedDeletions: stagedCounts.deletions,
        unstagedInsertions: unstagedCounts.insertions,
        unstagedDeletions: unstagedCounts.deletions,
      };
    });
}

/** `--numstat` rows, keyed by path. "-" is git's marker for a binary file. */
function parseNumstat(output: string): Map<string, { insertions: number; deletions: number }> {
  const counts = new Map<string, { insertions: number; deletions: number }>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const [added = "", removed = "", path = ""] = line.split("\t");
    if (path === "") continue;
    counts.set(path, {
      insertions: added === "-" ? 0 : Number.parseInt(added, 10) || 0,
      deletions: removed === "-" ? 0 : Number.parseInt(removed, 10) || 0,
    });
  }
  return counts;
}

/**
 * A patch, with truncation reported rather than thrown.
 *
 * The readers above collapse every failure into `null`, which is right for
 * "what branch am I on" but wrong for a diff: `git diff --no-index` exits 1
 * whenever the files differ, which is the only case that produces output at
 * all. So this keeps stdout on a non-zero exit, and caps the patch itself —
 * a 40MB diff is not something the review pane can render, and shipping it
 * over IPC would freeze the window before it tried.
 */
async function patch(
  cwd: string,
  args: readonly string[],
  maxBytes: number,
): Promise<{ diff: string; truncated: boolean }> {
  let stdout: string;
  try {
    ({ stdout } = await withGitSlot(() =>
      run("git", [...args], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
      }),
    ));
  } catch (error) {
    // A diff that found differences, a diff that overflowed the buffer, and a
    // diff that failed outright all land here; the first two still carry the
    // part of the patch git managed to write.
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  if (stdout.length <= maxBytes) return { diff: stdout, truncated: false };
  // Cut on a line boundary: half a hunk header parses as garbage.
  const cut = stdout.lastIndexOf("\n", maxBytes);
  return { diff: stdout.slice(0, cut > 0 ? cut : maxBytes), truncated: true };
}

/** How much of each patch survives the trip to the renderer. */
const MAX_TRACKED_DIFF_BYTES = 400_000;
const MAX_UNTRACKED_DIFF_BYTES = 120_000;
/** Untracked files are diffed one process each, so the count is bounded too. */
const MAX_UNTRACKED_FILES = 200;

const PATCH_FLAGS = [
  "--patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--minimal",
] as const;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Branches worth guessing at when nothing configured says what the base is. */
const BASE_BRANCH_CANDIDATES = ["main", "master", "develop"] as const;

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null;
}

/**
 * What "the branch changes" are measured against.
 *
 * The upstream is the honest answer when there is one. Without it this walks
 * an explicitly configured merge base,
 * then the remote's default branch, then the conventional names — preferring
 * the remote copy of each, because a stale local `main` makes the diff claim
 * changes that were merged weeks ago.
 */
export async function baseBranchFor(cwd: string, branch: string | null): Promise<string | null> {
  if (!branch) return null;

  const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const tracked = upstream?.trim();
  // A branch tracking its own remote copy would diff against itself.
  if (tracked && tracked !== `origin/${branch}` && (await refExists(cwd, tracked))) return tracked;

  const configured = (await git(cwd, ["config", "--get", `branch.${branch}.gh-merge-base`]))?.trim();
  const fromRemote = await defaultBranch(cwd, new Set<string>());
  for (const raw of [configured, fromRemote, ...BASE_BRANCH_CANDIDATES]) {
    const candidate = raw?.replace(/^origin\//, "").trim();
    if (!candidate || candidate === branch) continue;
    if (await refExists(cwd, `origin/${candidate}`)) return `origin/${candidate}`;
    if (await refExists(cwd, candidate)) return candidate;
  }
  return null;
}

/** Untracked files, as patches against nothing — git omits them from `diff`. */
async function untrackedPatch(cwd: string): Promise<{ diff: string; truncated: boolean }> {
  const listed = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = (listed ?? "").split("\0").filter((path) => path !== "");
  if (paths.length === 0) return { diff: "", truncated: false };

  const capped = paths.slice(0, MAX_UNTRACKED_FILES);
  const patches = await Promise.all(
    capped.map((path) =>
      patch(
        cwd,
        ["diff", "--no-index", ...PATCH_FLAGS, "--", devNull, path],
        MAX_UNTRACKED_DIFF_BYTES,
      ),
    ),
  );
  return {
    diff: patches
      .map((result) => result.diff.trimEnd())
      .filter((diff) => diff !== "")
      .join("\n"),
    truncated: capped.length < paths.length || patches.some((result) => result.truncated),
  };
}

export interface GitDiffPreviewSource {
  readonly id: string;
  /**
   * `staged` and `unstaged` are the two halves the SCM panel's groups render;
   * `working-tree` is both of them fused, which is what "what has changed since
   * the last commit" means and what the review pane has always shown.
   */
  readonly kind: "working-tree" | "branch-range" | "staged" | "unstaged";
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly diff: string;
  readonly diffHash: string;
  readonly truncated: boolean;
}

/** One row of the repository list a folder-of-repositories shows. */
export interface GitWorkspaceRepository {
  readonly path: string;
  readonly branch: string | null;
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface GitDiffPreview {
  readonly isRepo: boolean;
  readonly sources: readonly GitDiffPreviewSource[];
  /**
   * Set only when `cwd` holds repositories rather than being one. `sources` is
   * empty in that case — the panel lists these and asks again per repository.
   */
  readonly workspaceRepositories?: readonly GitWorkspaceRepository[];
}

/**
 * The two patches the review pane switches between.
 *
 * "Working tree" is everything since the last commit — staged and unstaged
 * together, plus untracked files, because "what has changed" does not mean
 * "what I remembered to `git add`". "Branch changes" is `base...HEAD`, the
 * three-dot form, so commits that landed on the base after this branch started
 * do not show up as changes this branch made.
 *
 * Both are always returned, even empty: the pane keeps its two tabs and shows
 * "no changes" rather than losing one of them.
 */
interface RepoPatches {
  readonly branch: string | null;
  readonly baseRef: string | null;
  readonly workingTree: string;
  readonly workingTreeTruncated: boolean;
  readonly range: string;
  readonly rangeTruncated: boolean;
  /** The index against HEAD — what a commit right now would contain. */
  readonly staged: string;
  readonly stagedTruncated: boolean;
  /** The working tree against the index, plus untracked files. */
  readonly unstaged: string;
  readonly unstagedTruncated: boolean;
}

/** Both patches for one repository: the working tree, and the branch range. */
async function repoPatches(
  cwd: string,
  options: {
    readonly baseRef?: string;
    readonly ignoreWhitespace?: boolean;
    readonly contextLines?: number;
  },
): Promise<RepoPatches> {
  const whitespace = options.ignoreWhitespace ? ["--ignore-all-space"] : [];
  // Bounded: a full-context diff of a huge file is still capped by the byte
  // limit below, but there is no reason to ask git for more than a file has.
  const context =
    options.contextLines === undefined
      ? []
      : [`--unified=${Math.max(0, Math.min(100_000, Math.floor(options.contextLines)))}`];
  const branch = (await git(cwd, ["branch", "--show-current"]))?.trim() || null;
  const baseRef = options.baseRef?.trim() || (await baseBranchFor(cwd, branch));

  const [tracked, untracked, range, staged, unstaged] = await Promise.all([
    patch(
      cwd,
      ["diff", ...PATCH_FLAGS, ...whitespace, ...context, "HEAD", "--"],
      MAX_TRACKED_DIFF_BYTES,
    ),
    untrackedPatch(cwd),
    baseRef
      ? patch(
          cwd,
          ["diff", ...PATCH_FLAGS, ...whitespace, ...context, `${baseRef}...HEAD`],
          MAX_TRACKED_DIFF_BYTES,
        )
      : Promise.resolve({ diff: "", truncated: false }),
    // `--cached` is the index against HEAD; a bare `diff` is the working tree
    // against the index. `diff HEAD` above is neither, and for a file staged
    // and then edited again it equals neither side.
    patch(cwd, ["diff", ...PATCH_FLAGS, ...whitespace, ...context, "--cached", "--"], MAX_TRACKED_DIFF_BYTES),
    patch(cwd, ["diff", ...PATCH_FLAGS, ...whitespace, ...context, "--"], MAX_TRACKED_DIFF_BYTES),
  ]);

  return {
    branch,
    baseRef,
    staged: staged.diff,
    stagedTruncated: staged.truncated,
    // Untracked files belong here rather than with the staged side: they have
    // no index entry at all, so nothing about them is staged.
    unstaged: [unstaged.diff.trimEnd(), untracked.diff.trimEnd()]
      .filter((diff) => diff !== "")
      .join("\n"),
    unstagedTruncated: unstaged.truncated || untracked.truncated,
    workingTree: [tracked.diff.trimEnd(), untracked.diff.trimEnd()]
      .filter((diff) => diff !== "")
      .join("\n"),
    workingTreeTruncated: tracked.truncated || untracked.truncated,
    range: range.diff,
    rangeTruncated: range.truncated,
  };
}

function diffSources(input: {
  readonly workingTree: string;
  readonly workingTreeTruncated: boolean;
  readonly range: string;
  readonly rangeTruncated: boolean;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly rangeTitle: string;
  /** Absent for a folder of repositories, which has no single index. */
  readonly staged?: string;
  readonly stagedTruncated?: boolean;
  readonly unstaged?: string;
  readonly unstagedTruncated?: boolean;
}): GitDiffPreview {
  return {
    isRepo: true,
    sources: [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Working tree",
        baseRef: "HEAD",
        headRef: null,
        diff: input.workingTree,
        diffHash: sha256(input.workingTree),
        truncated: input.workingTreeTruncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: input.rangeTitle,
        baseRef: input.baseRef,
        headRef: input.headRef,
        diff: input.range,
        diffHash: sha256(input.range),
        truncated: input.rangeTruncated,
      },
      /**
       * The two halves, for the SCM panel's groups.
       *
       * Appended rather than inserted, and omitted entirely where there is no
       * index: the review pane picks its source by `id`, so anything reading
       * the first two entries keeps getting exactly what it got before.
       */
      ...(input.staged === undefined
        ? []
        : [
            {
              id: "staged",
              kind: "staged" as const,
              title: "Staged changes",
              baseRef: "HEAD",
              headRef: null,
              diff: input.staged,
              diffHash: sha256(input.staged),
              truncated: input.stagedTruncated ?? false,
            },
          ]),
      ...(input.unstaged === undefined
        ? []
        : [
            {
              id: "unstaged",
              kind: "unstaged" as const,
              title: "Changes",
              baseRef: null,
              headRef: null,
              diff: input.unstaged,
              diffHash: sha256(input.unstaged),
              truncated: input.unstagedTruncated ?? false,
            },
          ]),
    ],
  };
}

export async function diffPreview(
  cwd: string,
  options: {
    readonly baseRef?: string;
    readonly ignoreWhitespace?: boolean;
    /**
     * Lines of context around each change.
     *
     * git's default of three shows hunks; a large number shows the whole file
     * with its changes marked inside it, which is what a source-control view
     * wants — you are reading the file, not auditing a patch.
     */
    readonly contextLines?: number;
  } = {},
): Promise<GitDiffPreview> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return workspaceDiffPreview(cwd);

  const repo = await repoPatches(cwd, options);
  return diffSources({
    ...repo,
    headRef: repo.branch ?? "HEAD",
    rangeTitle: repo.baseRef ? `Against ${repo.baseRef}` : "Against base branch",
  });
}

/**
 * What a folder of repositories offers instead of a diff: the repositories.
 *
 * Concatenating every child's patch was the obvious first move and the wrong
 * one. Thirty-four repositories came to 17k added lines, blew past the preview
 * cap, and arrived as one undifferentiated wall the panel had to parse on the
 * main thread — slow to open and impossible to read.
 *
 * So this reads only what a list needs: each repository's branch and change
 * counts, which is a `numstat` and an `ls-files`, no patch text at all. The
 * panel renders that list, and asks for a real diff — through the ordinary
 * single-repository path — only for the one the user opens.
 *
 * Repositories with changes sort first, largest first, because those are the
 * ones being looked for; the quiet ones stay listed underneath in name order.
 */
async function workspaceDiffPreview(cwd: string): Promise<GitDiffPreview> {
  const repositories = await workspaceRepositories(cwd);
  if (repositories.length === 0) return { isRepo: false, sources: [] };

  const rows = await Promise.all(
    repositories.map(async (repository): Promise<GitWorkspaceRepository> => {
      // Two git calls, not seven; see `repositorySummary`.
      const child = await repositorySummary(join(cwd, repository)).catch(() => null);
      return {
        path: repository,
        branch: child?.branch ?? null,
        filesChanged: child?.filesChanged ?? 0,
        insertions: child?.insertions ?? 0,
        deletions: child?.deletions ?? 0,
      };
    }),
  );

  const ordered = rows.toSorted((left, right) => {
    if ((left.filesChanged > 0) !== (right.filesChanged > 0)) {
      return left.filesChanged > 0 ? -1 : 1;
    }
    if (left.filesChanged !== right.filesChanged) return right.filesChanged - left.filesChanged;
    return left.path.localeCompare(right.path);
  });

  // No sources: there is nothing to diff at this level. The panel lists
  // `workspaceRepositories` and re-asks with a child's path when one is opened.
  return { isRepo: true, sources: [], workspaceRepositories: ordered };
}

/**
 * `git init` — the one write this module allows.
 *
 * Everything else here is read-only because the agent is the thing that
 * writes, but "Initialize Git" is a different kind of action: it creates a
 * repository in a folder the user picked, touches nothing that already exists,
 * and there is no agent involved to do it for them. Refusing it left the
 * button in the UI failing with `vcs.init is not supported`.
 *
 * Errors are RAISED rather than swallowed into a null like the readers above:
 * a status that cannot be read is fairly reported as "not a repo", but an init
 * that silently did nothing would leave the button looking broken again.
 */
export async function init(cwd: string): Promise<void> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  // Already a repo — including a parent being one, which is what `git init` in
  // a subdirectory would silently turn into a confusing nested repository.
  if (inside?.trim() === "true") return;
  try {
    await run("git", ["init"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch (error) {
    // git writes the useful part to stderr ("permission denied", "not a
    // directory"); the exec error's own message is just the exit code.
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git init failed in ${cwd}`);
  }
}
