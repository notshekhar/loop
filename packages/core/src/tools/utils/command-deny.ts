/**
 * Bash command denylist — a configurable guardrail, NOT a security boundary.
 *
 * It parses the command line and refuses anything whose resolved command name
 * (optionally + subcommand) matches a denied entry. This reliably stops an
 * honest model and ordinary invocations; it does NOT stop a determined bypass
 * (base64-pipe-to-sh, write-a-script-then-run-it, eval, …). String inspection
 * is fundamentally bypassable — that's what an OS sandbox is for, and we're
 * deliberately deferring that. Keep this in mind before trusting it as a jail.
 */

/** A denied command — a command name, optionally + subcommand ("git commit"). */
export type BashDenyEntry = string;

/**
 * Coerce a stored entry to its pattern string. Tolerates the legacy
 * `{ pattern, reason }` object form that older builds persisted to settings, so
 * an existing ~/.loop/settings.json doesn't crash after the type changed.
 */
export function denyPattern(entry: unknown): string {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && typeof (entry as { pattern?: unknown }).pattern === "string") {
        return (entry as { pattern: string }).pattern;
    }
    return "";
}

/**
 * Seeded when the user hasn't configured `bashDeny`. Commit/push stay with the
 * human (commit or push only when explicitly asked). Users override the whole
 * list via settings.
 */
export const DEFAULT_BASH_DENY: BashDenyEntry[] = ["git commit", "git push"];

/**
 * Commands that run another command; we look past them to the real one so
 * `sudo rm` or `rtk git commit` resolve to `rm` / `git commit`. This closes the
 * easy wrapper bypass — it does not (and cannot) close every bypass.
 * `rtk` is the user's token-proxy that rewrites every command (`rtk <cmd>`, or
 * `rtk proxy <cmd>` for raw passthrough); treat both forms as transparent.
 */
const WRAPPERS = new Set([
    "sudo",
    "env",
    "command",
    "nohup",
    "time",
    "timeout",
    "nice",
    "ionice",
    "chrt",
    "stdbuf",
    "xargs",
    "rtk",
]);

/**
 * Wrapper options that take their value as the NEXT token (`nice -n 10`,
 * `timeout -s KILL 5`), so the value is peeled with the option rather than
 * mistaken for the real command.
 */
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
    sudo: new Set(["-u", "--user", "-g", "--group", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]),
    env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
    timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
    nice: new Set(["-n", "--adjustment"]),
    ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]),
    chrt: new Set(["-p", "--pid"]),
    stdbuf: new Set(["-i", "-o", "-e"]),
    xargs: new Set(["-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a"]),
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A wrapper's bare numeric argument: `timeout 5`, `timeout 1.5m`, `chrt 10`. */
const WRAPPER_NUMBER = /^\d+(\.\d+)?[smhd]?$/;

/**
 * Drop the prefix that only sets up the real command: env assignments,
 * wrapper commands, and each wrapper's own options and numeric arguments.
 * Either kind can come first (`env FOO=1 sudo rm`), so they interleave.
 * Tokens are returned as written; shared with the permission rules engine,
 * which matches the peeled text.
 */
export function peelWrappers(tokens: string[]): string[] {
    let wrapper: string | null = null;
    let i = 0;
    for (; i < tokens.length; i++) {
        const token = tokens[i];
        if (ENV_ASSIGNMENT.test(token)) continue;
        const head = normalizeToken(token);
        if (WRAPPERS.has(head)) {
            wrapper = head;
            // `rtk proxy <cmd>` — the proxy subcommand is part of the wrapper.
            if (head === "rtk" && normalizeToken(tokens[i + 1] ?? "") === "proxy") i++;
            continue;
        }
        if (wrapper && token.startsWith("-")) {
            if (WRAPPER_VALUE_OPTIONS[wrapper]?.has(token)) i++;
            continue;
        }
        if (wrapper && WRAPPER_NUMBER.test(token)) continue;
        break;
    }
    return tokens.slice(i);
}

/** Shell operators that separate one executed command from the next. */
const SEGMENT_SEPARATORS = /\|\||&&|[;|&\n]/;

/** `sh -c "<script>"` (and bash/zsh/…) runs an inline script — pull it out. */
const SHELL_DASH_C = /\b(?:sh|bash|zsh|dash|ksh)\s+-c\s+(['"])([\s\S]*?)\1/g;

/** Strip surrounding quotes, then reduce a path to its basename (/bin/rm → rm). */
function normalizeToken(token: string): string {
    const unquoted = token.replace(/^['"]+/, "").replace(/['"]+$/, "");
    const base = unquoted.split("/").pop();
    return base && base.length > 0 ? base : unquoted;
}

/**
 * Break a command line into the individual commands it would run. Command
 * substitutions ($(...) and `...`) are flattened into their own segments so a
 * denied command hidden inside one is still seen. Exported for the permission
 * rules engine, which applies deny/ask rules per segment with the same split.
 */
export function splitSegments(command: string): string[] {
    const flattened = command
        .replace(SHELL_DASH_C, " ; $2 ; ")
        .replace(/\$\(([\s\S]*?)\)/g, " ; $1 ; ")
        .replace(/`/g, " ; ");
    return flattened
        .split(SEGMENT_SEPARATORS)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
}

/**
 * Resolve one segment to its real command token plus the following tokens.
 * The setup prefix (env assignments, wrappers and their options) is peeled
 * off so `sudo FOO=1 /bin/rm -rf` resolves to command `rm`.
 */
export function resolveSegment(segment: string): { command: string; rest: string[] } | null {
    const tokens = peelWrappers(segment.split(/\s+/).filter(Boolean));
    if (tokens.length === 0) return null;
    return {
        command: normalizeToken(tokens[0]),
        rest: tokens.slice(1).map(normalizeToken),
    };
}

/**
 * Whether a resolved segment matches a denylist pattern. Single-word patterns
 * ("rm") match on the command name; multi-word patterns ("git commit") also
 * require the following tokens to match as a prefix.
 */
export function segmentMatchesPattern(resolved: { command: string; rest: string[] }, pattern: string): boolean {
    const words = pattern.trim().split(/\s+/).map(normalizeToken);
    if (words.length === 0 || words[0] !== resolved.command) return false;
    const subcommands = words.slice(1);
    return subcommands.every((word, index) => resolved.rest[index] === word);
}

/**
 * Return the first denylist pattern the command would trigger, or null if none.
 * The first matching entry wins, in denylist order.
 */
export function findDeniedCommand(command: string, denylist: BashDenyEntry[]): string | null {
    if (denylist.length === 0) return null;
    const segments = splitSegments(command);
    const resolved = segments.map(resolveSegment).filter((s): s is { command: string; rest: string[] } => s !== null);

    for (const entry of denylist) {
        const pattern = denyPattern(entry);
        if (!pattern) continue;
        if (resolved.some((segment) => segmentMatchesPattern(segment, pattern))) {
            return pattern;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Approval allowlist (bashApprove setting) — the mirror image of the denylist.
// Same pattern shape and the same segment parser, so "git status" allows
// `git status -sb` but not `git push`, and wrappers/substitutions can't hide a
// second command: EVERY resolved segment must match for the run to skip the
// prompt.
// ---------------------------------------------------------------------------

/**
 * Whether a command is pre-approved by the allowlist: every executed segment
 * matches some entry. Fail closed — no segments resolved (empty/odd input) or
 * an empty allowlist means "not allowed" (i.e. prompt).
 */
export function isCommandAllowed(command: string, allowlist: BashDenyEntry[]): boolean {
    if (allowlist.length === 0) return false;
    const patterns = allowlist.map(denyPattern).filter((p) => p.length > 0);
    if (patterns.length === 0) return false;
    const resolved = splitSegments(command)
        .map(resolveSegment)
        .filter((s): s is { command: string; rest: string[] } => s !== null);
    if (resolved.length === 0) return false;
    return resolved.every((segment) => patterns.some((pattern) => segmentMatchesPattern(segment, pattern)));
}

/**
 * Subcommand-style tools where "always allow" should scope to the subcommand
 * ("git status", "npm install") instead of the whole tool — allowing all of
 * `git` because the user approved `git status` would be far too broad.
 */
const SUBCOMMAND_TOOLS = new Set([
    "git",
    "gh",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "deno",
    "cargo",
    "go",
    "docker",
    "kubectl",
    "helm",
    "pip",
    "pip3",
    "uv",
    "brew",
    "apt",
    "apt-get",
    "gem",
    "mvn",
    "gradle",
    "composer",
    "gcloud",
    "aws",
    "az",
    "terraform",
    "systemctl",
]);

/** Looks like a subcommand word (not a flag, path, or file). */
const SUBCOMMAND_WORD = /^[a-z][a-z0-9-]*$/i;

/**
 * The patterns "always allow" would persist for this command — one per
 * executed segment, deduped. Subcommand tools store "cmd sub"; everything
 * else stores the bare command name.
 */
export function suggestAllowPatterns(command: string): string[] {
    const out: string[] = [];
    for (const segment of splitSegments(command)) {
        const resolved = resolveSegment(segment);
        if (!resolved) continue;
        const sub = resolved.rest[0];
        const pattern =
            SUBCOMMAND_TOOLS.has(resolved.command) && sub && SUBCOMMAND_WORD.test(sub)
                ? `${resolved.command} ${sub}`
                : resolved.command;
        if (!out.includes(pattern)) out.push(pattern);
    }
    return out;
}

/**
 * The refusal handed back to the model when the user denies an approval
 * prompt. A live human decision, not policy — so "this command, this time":
 * don't retry or work around it, but continuing the task is fine.
 */
export function formatApprovalRefusal(command: string): string {
    const first = command.split("\n")[0];
    const shown = first.length > 80 ? `${first.slice(0, 77)}…` : first;
    return (
        `The user reviewed \`${shown}\` and declined to run it. ` +
        `Don't retry it or run an equivalent (different flags, a script, piping). ` +
        `Continue the task without it, or explain what you needed it for and let the user decide.`
    );
}

/**
 * The refusal handed back to the model. Kept to 2-3 lines but deliberately
 * framed as the user's settled decision (not an error) and ruling out
 * equivalents, so the model redirects instead of hunting for a workaround.
 */
export function formatDenyRefusal(pattern: string): string {
    return (
        `\`${pattern}\` is blocked by the user's bash policy — intentional, not an error. ` +
        `Don't retry it or run an equivalent (different flags, full path, piping, a script). ` +
        `If it's truly required, ask the user to run it or to remove it from their denylist; otherwise continue without it.`
    );
}
