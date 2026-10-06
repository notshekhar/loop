/**
 * Repository-level GitHub operations: look up, clone, publish.
 *
 * The commit/push/PR path in `gitActions.ts` works inside a repository that
 * already exists. These three are about the repository itself — finding one,
 * bringing one down, and putting a local folder up — and all three failed as
 * "not supported by loop's desktop app", which is what the "Publish failed"
 * toast was.
 *
 * All of it goes through `gh` rather than the REST API: `gh` already holds the
 * user's credentials in the system keyring, and reimplementing OAuth here to
 * make the same calls would be a second place for tokens to live.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readGit } from "./git";

const run = promisify(execFile);

const LOOKUP_TIMEOUT_MS = 30_000;
/** Cloning and pushing move bytes over the network. */
const TRANSFER_TIMEOUT_MS = 600_000;

export interface RepositoryInfo {
    readonly provider: "github";
    readonly nameWithOwner: string;
    readonly url: string;
    readonly sshUrl: string;
}

export interface PublishResult {
    readonly repository: RepositoryInfo;
    readonly remoteName: string;
    readonly remoteUrl: string;
    readonly branch: string;
    readonly upstreamBranch: string | null;
    readonly status: "pushed" | "remote_added";
}

interface GhResult {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

async function gh(args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<GhResult> {
    try {
        const { stdout, stderr } = await run("gh", [...args], {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            timeout: options.timeoutMs ?? LOOKUP_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" },
        });
        return { ok: true, stdout, stderr };
    } catch (error) {
        const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        if (e.code === "ENOENT") {
            throw new Error("The GitHub CLI (gh) is not installed or not on PATH.");
        }
        return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
}

/** git's own message beats gh's exit code for anything the user must act on. */
function ghError(operation: string, result: GhResult): Error {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    return new Error(`${operation} failed: ${detail}`);
}

const REPO_FIELDS = "nameWithOwner,url,sshUrl";

function parseRepository(stdout: string): RepositoryInfo | null {
    try {
        const parsed = JSON.parse(stdout) as Partial<RepositoryInfo>;
        if (!parsed.nameWithOwner || !parsed.url) return null;
        return {
            provider: "github",
            nameWithOwner: parsed.nameWithOwner,
            url: parsed.url,
            // A repo with no SSH URL in the payload still needs a usable one.
            sshUrl: parsed.sshUrl || `git@github.com:${parsed.nameWithOwner}.git`,
        };
    } catch {
        return null;
    }
}

/** Find a repository by `owner/name`, or null when it does not exist. */
export async function lookupRepository(repository: string): Promise<RepositoryInfo | null> {
    const result = await gh(["repo", "view", repository, "--json", REPO_FIELDS]);
    if (!result.ok) return null;
    return parseRepository(result.stdout);
}

/**
 * Clone into `destinationPath`.
 *
 * `git clone` rather than `gh repo clone` when an explicit remote URL is given,
 * because the caller may be cloning something that is not a GitHub repo at all.
 */
export async function cloneRepository(input: {
    readonly repository?: string | undefined;
    readonly remoteUrl?: string | undefined;
    readonly destinationPath: string;
    readonly protocol?: "auto" | "ssh" | "https" | undefined;
}): Promise<{ cwd: string; remoteUrl: string; repository: RepositoryInfo | null }> {
    if (input.remoteUrl) {
        try {
            await run("git", ["clone", input.remoteUrl, input.destinationPath], {
                timeout: TRANSFER_TIMEOUT_MS,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            });
        } catch (error) {
            const stderr = (error as { stderr?: string }).stderr?.trim();
            throw new Error(`git clone failed: ${stderr || String(error)}`);
        }
        return { cwd: input.destinationPath, remoteUrl: input.remoteUrl, repository: null };
    }

    if (!input.repository) throw new Error("a repository or a remote URL is required");
    const found = await lookupRepository(input.repository);
    const result = await gh(
        [
            "repo",
            "clone",
            input.repository,
            input.destinationPath,
            ...(input.protocol === "ssh" || input.protocol === "https"
                ? ["--", "--config", `url.${input.protocol}`]
                : []),
        ],
        { timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    if (!result.ok) throw ghError("gh repo clone", result);
    return {
        cwd: input.destinationPath,
        remoteUrl: (input.protocol === "ssh" ? found?.sshUrl : found?.url) ?? found?.url ?? "",
        repository: found,
    };
}

/**
 * Put a local folder on GitHub.
 *
 * `--push` is only passed when there is actually a commit to push: `gh` fails
 * outright on a repository with no commits, and the honest outcome there is
 * "the remote exists, you have nothing to send it yet" rather than an error
 * that leaves a created-but-unlinked repo behind.
 */
export async function publishRepository(input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: "private" | "public";
    readonly remoteName?: string | undefined;
}): Promise<PublishResult> {
    const inside = await readGit(input.cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside?.trim() !== "true") throw new Error(`${input.cwd} is not a git repository`);

    const remoteName = input.remoteName?.trim() || "origin";
    const hasCommits = (await readGit(input.cwd, ["rev-parse", "--verify", "HEAD"]))?.trim();
    const branch = (await readGit(input.cwd, ["branch", "--show-current"]))?.trim() || "main";

    const result = await gh(
        [
            "repo",
            "create",
            input.repository,
            `--${input.visibility}`,
            "--source",
            input.cwd,
            "--remote",
            remoteName,
            ...(hasCommits ? ["--push"] : []),
        ],
        { cwd: input.cwd, timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    if (!result.ok) throw ghError("gh repo create", result);

    const info = await lookupRepository(input.repository);
    if (!info) throw new Error(`published, but ${input.repository} could not be read back`);

    const remoteUrl = (await readGit(input.cwd, ["remote", "get-url", remoteName]))?.trim() || info.url;
    const upstream = hasCommits
        ? (await readGit(input.cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{u}`]))?.trim() ||
          null
        : null;

    return {
        repository: info,
        remoteName,
        remoteUrl,
        branch,
        upstreamBranch: upstream,
        status: hasCommits ? "pushed" : "remote_added",
    };
}
