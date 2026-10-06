/**
 * What source-control tooling this machine actually has.
 *
 * The settings screen's "Server environment" panel asks for this so it can say
 * whether git is present, whether `gh` is installed, and whether `gh` is signed
 * in — the three facts that decide whether the commit/push/PR buttons can work
 * at all. Without it the panel showed "Could not scan the server environment:
 * server.discoverSourceControl is not supported by loop's desktop app".
 *
 * Everything here is a version probe and an auth probe, and nothing here makes
 * a network call: `gh auth status` reads the local keyring. A scan that phoned
 * GitHub would make opening a settings page cost a round trip and would fail
 * offline, which is the opposite of what a diagnostics panel is for.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A probe that hangs is worse than one that reports "missing". */
const PROBE_TIMEOUT_MS = 5_000;

export type DiscoveryStatus = "available" | "missing";
export type ProviderAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface DiscoveredVcs {
    readonly kind: "git" | "jj" | "unknown";
    readonly implemented: boolean;
    readonly label: string;
    readonly executable: string;
    readonly status: DiscoveryStatus;
    readonly version: string | null;
    readonly installHint: string;
    readonly detail: string | null;
}

export interface DiscoveredProvider {
    readonly kind: "github" | "gitlab" | "azure-devops" | "bitbucket" | "unknown";
    readonly label: string;
    readonly executable: string;
    readonly status: DiscoveryStatus;
    readonly version: string | null;
    readonly installHint: string;
    readonly detail: string | null;
    readonly auth: {
        readonly status: ProviderAuthStatus;
        readonly account: string | null;
        readonly host: string | null;
        readonly detail: string | null;
    };
}

export interface SourceControlDiscovery {
    readonly versionControlSystems: readonly DiscoveredVcs[];
    readonly sourceControlProviders: readonly DiscoveredProvider[];
}

interface ProbeResult {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

/** Run a probe. A missing binary and a failing one are both just "not ok". */
async function probe(command: string, args: readonly string[]): Promise<ProbeResult> {
    try {
        const { stdout, stderr } = await run(command, [...args], {
            timeout: PROBE_TIMEOUT_MS,
            env: { ...process.env, GIT_PAGER: "cat", GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" },
        });
        return { ok: true, stdout, stderr };
    } catch (error) {
        const e = error as { stdout?: string; stderr?: string };
        return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
}

/** `git version 2.54.0` / `gh version 2.95.0 (2026-06-17)` → `2.54.0`. */
export function parseVersion(output: string): string | null {
    const match = /(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?)/.exec(output);
    return match?.[1] ?? null;
}

/**
 * Read `gh auth status`.
 *
 * `gh` writes this to stdout on modern versions and stderr on older ones, so
 * both are searched — checking only one made a signed-in user look
 * unauthenticated. Exit code alone is not enough either: it is non-zero when
 * *any* configured host is logged out, even if the one that matters is fine.
 */
export function parseGhAuth(result: ProbeResult): DiscoveredProvider["auth"] {
    const text = `${result.stdout}\n${result.stderr}`;
    // "✓ Logged in to github.com account notshekhar (keyring)"
    const loggedIn = /Logged in to (\S+) account (\S+)/.exec(text);
    if (loggedIn) {
        return {
            status: "authenticated",
            account: loggedIn[2] ?? null,
            host: loggedIn[1] ?? null,
            detail: null,
        };
    }
    if (/not logged in|You are not logged into any GitHub hosts/i.test(text)) {
        return {
            status: "unauthenticated",
            account: null,
            host: null,
            detail: "Run `gh auth login` to sign in.",
        };
    }
    // Something answered but not in a shape we know — say so rather than
    // guessing, so the panel does not claim an auth state it cannot support.
    const firstLine = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "");
    return {
        status: "unknown",
        account: null,
        host: null,
        detail: firstLine ?? null,
    };
}

const GIT_HINT = "Install Git from https://git-scm.com/downloads, then rescan.";
const JJ_HINT = "Jujutsu is detected but loop drives git only.";
const GH_HINT = "Install the GitHub CLI (`brew install gh`), then run `gh auth login`.";

/**
 * Probe git, jj and the GitHub CLI.
 *
 * Only GitHub is listed among the providers because `gh` is the only one loop
 * can actually act through — the PR path shells out to it. Listing GitLab or
 * Azure DevOps as "available" because their CLI happens to be installed would
 * promise a button that does not exist.
 */
export async function discoverSourceControl(): Promise<SourceControlDiscovery> {
    const [git, jj, gh] = await Promise.all([
        probe("git", ["--version"]),
        probe("jj", ["--version"]),
        probe("gh", ["--version"]),
    ]);

    const versionControlSystems: DiscoveredVcs[] = [
        {
            kind: "git",
            implemented: true,
            label: "Git",
            executable: "git",
            status: git.ok ? "available" : "missing",
            version: git.ok ? parseVersion(git.stdout) : null,
            installHint: GIT_HINT,
            detail: git.ok ? null : "git is not installed or not on PATH.",
        },
        {
            kind: "jj",
            // loop has one VCS driver and it is git; jj is reported for honesty, not
            // as something the UI can switch to.
            implemented: false,
            label: "Jujutsu",
            executable: "jj",
            status: jj.ok ? "available" : "missing",
            version: jj.ok ? parseVersion(jj.stdout) : null,
            installHint: JJ_HINT,
            detail: "loop drives git; jj repositories are not supported yet.",
        },
    ];

    // No point asking about auth for a binary that is not there.
    const ghAuth = gh.ok
        ? parseGhAuth(await probe("gh", ["auth", "status"]))
        : {
              status: "unknown" as const,
              account: null,
              host: null,
              detail: "Install the GitHub CLI to check sign-in.",
          };

    const sourceControlProviders: DiscoveredProvider[] = [
        {
            kind: "github",
            label: "GitHub",
            executable: "gh",
            status: gh.ok ? "available" : "missing",
            version: gh.ok ? parseVersion(gh.stdout) : null,
            installHint: GH_HINT,
            detail: gh.ok
                ? "Used to open and read pull requests."
                : "gh is not installed or not on PATH; pull requests are unavailable.",
            auth: ghAuth,
        },
    ];

    return { versionControlSystems, sourceControlProviders };
}
