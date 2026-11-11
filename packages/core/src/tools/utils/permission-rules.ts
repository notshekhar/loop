/**
 * Permission rules — allow / ask / deny, layered over the tools.
 *
 * Rule strings use the Claude-settings shape: `Bash(git *)`, `Read(src/**)`,
 * `Edit(secrets/**)`, a bare tool name (`Read`), or `*` for every tool. Rules
 * come from the global settings.json `permissions` key and (trust-gated) from
 * each project's <dir>/CONFIG_DIR/settings.json walking cwd up to the git
 * root. All sources merge into one set; severity decides, never order or
 * source: any matching deny rejects, else any matching ask prompts, else any
 * matching allow approves, else the caller falls through to its existing
 * behavior (denylist / approval prompt / run).
 *
 * Matching semantics (deliberately grok-build compatible):
 * - Bash patterns match as a literal prefix, or as a glob over the whole
 *   command when they contain glob chars (`*` crosses spaces and slashes).
 *   A trailing `:*` is stripped to a plain prefix.
 * - Bash deny/ask rules are checked against every executed segment (split on
 *   &&, ||, ;, |, newlines — with $(...), backticks and `sh -c` flattened) and
 *   against the whole string; one denied segment rejects the whole command.
 *   Allow rules match the whole string only, so `Bash(git *)` does not
 *   auto-approve `git status && rm -rf /` segments — pair with deny rules.
 * - Path patterns (Read/Edit/Grep) are globs where `*`/`?` do not cross `/`
 *   and `**` does; a pattern without glob chars matches only exactly.
 *
 * Like the denylist, this is a guardrail for honest models, not a security
 * boundary — the OS sandbox is the jail.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../../brand";
import { isTrusted } from "../../agent/trust";
import { getSetting } from "../../settings";
import { getBashApprovalBridge } from "../approval-bridge";
import { peelWrappers, resolveSegment, segmentMatchesPattern, splitSegments } from "./command-deny";

export type PermissionAction = "allow" | "ask" | "deny";

/** Loop's rule tool classes. `read` also covers ls; `edit` covers write;
 * `grep` covers find. `*` matches every class. */
export type PermissionToolClass = "bash" | "read" | "edit" | "grep" | "websearch" | "mcp" | "*";

export interface PermissionRule {
    action: PermissionAction;
    tool: PermissionToolClass;
    /** Absent = the rule matches every call of that tool class. */
    pattern?: string;
    /** The rule string as the user wrote it — shown in refusals/prompts. */
    source: string;
}

/** The settings.json `permissions` value (global or per-project). */
export interface PermissionsSetting {
    allow?: string[];
    ask?: string[];
    deny?: string[];
}

/** Rule-string tool name → tool class. Aliases follow the Claude rule names
 * (Write/Glob/…) so imported rule sets keep working. Unknown names are
 * skipped rather than failing the load. */
const TOOL_CLASS_BY_NAME: Record<string, PermissionToolClass> = {
    bash: "bash",
    read: "read",
    notebookread: "read",
    ls: "read",
    edit: "edit",
    write: "edit",
    notebookedit: "edit",
    grep: "grep",
    glob: "grep",
    find: "grep",
    websearch: "websearch",
    mcptool: "mcp",
    mcp: "mcp",
    "*": "*",
};

/** Parse one rule string ("Bash(git *)", "Read", "*"). Null = unrecognized. */
export function parseRuleString(action: PermissionAction, raw: string): PermissionRule | null {
    const m = /^\s*([A-Za-z*]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(raw);
    if (!m) return null;
    const tool = TOOL_CLASS_BY_NAME[m[1].toLowerCase()];
    if (!tool) return null;
    const pattern = m[2]?.trim();
    return { action, tool, pattern: pattern || undefined, source: raw.trim() };
}

/** Parse a permissions setting into rules, skipping unrecognized entries. */
export function parsePermissionsSetting(setting: PermissionsSetting | undefined): PermissionRule[] {
    if (!setting) return [];
    const out: PermissionRule[] = [];
    const sections: Array<[PermissionAction, unknown]> = [
        ["deny", setting.deny],
        ["ask", setting.ask],
        ["allow", setting.allow],
    ];
    for (const [action, list] of sections) {
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
            if (typeof raw !== "string") continue;
            const rule = parseRuleString(action, raw);
            if (rule) out.push(rule);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const GLOB_CHARS = /[*?[]/;

/**
 * Compile a glob to a RegExp. `pathMode` gives path semantics (`*`/`?` stop at
 * `/`, `**` crosses); bash mode lets `*` cross anything (spaces, slashes).
 * `[...]` classes pass through in both modes.
 */
function globToRegExp(pattern: string, pathMode: boolean): RegExp {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pathMode && pattern[i + 1] === "*") {
                i++;
                if (pattern[i + 1] === "/") {
                    // `**/` matches zero or more whole directories, so
                    // `**/.env` also matches a top-level `.env`.
                    i++;
                    re += "(?:.*/)?";
                } else {
                    re += ".*";
                }
            } else {
                re += pathMode ? "[^/]*" : "[\\s\\S]*";
            }
        } else if (ch === "?") {
            re += pathMode ? "[^/]" : ".";
        } else if (ch === "[") {
            // Pass a character class through to the regex unchanged.
            const close = pattern.indexOf("]", i + 1);
            if (close === -1) {
                re += "\\[";
            } else {
                re += pattern.slice(i, close + 1);
                i = close;
            }
        } else {
            re += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
        }
    }
    return new RegExp(`^${re}$`);
}

/**
 * Whether a Bash rule pattern matches a command string: literal prefix, or —
 * when the pattern has glob chars — a glob over the whole string. A trailing
 * `:*` reduces to a plain prefix (`Bash(git commit:*)` → prefix `git commit`).
 */
export function matchBashPattern(pattern: string, command: string): boolean {
    let p = pattern.trim();
    if (p.endsWith(":*")) p = p.slice(0, -2).trimEnd();
    const cmd = command.trimStart();
    if (cmd.startsWith(p)) return true;
    return GLOB_CHARS.test(p) && globToRegExp(p, false).test(cmd);
}

/** A segment with its setup prefix peeled, keeping the raw text:
 * `RUST_LOG=x timeout 5 git push` → `git push`, so deny/ask rules match the
 * wrapped or the inner command. The same peel as the denylist's. */
function peelSegment(segment: string): string {
    return peelWrappers(segment.split(/\s+/).filter(Boolean)).join(" ");
}

/** Whether a bash rule matches the command at segment level (deny/ask
 * semantics): the whole string, any executed segment, or a segment with its
 * env/wrapper prefix peeled. */
function bashRuleMatchesSegments(pattern: string, command: string): boolean {
    if (matchBashPattern(pattern, command)) return true;
    for (const segment of splitSegments(command)) {
        if (matchBashPattern(pattern, segment)) return true;
        const peeled = peelSegment(segment);
        if (peeled && peeled !== segment && matchBashPattern(pattern, peeled)) return true;
    }
    return false;
}

/**
 * Whether a path rule pattern matches a path string. Globs use path semantics;
 * a pattern with no glob chars matches only the exact string. Paths are
 * matched as given (no canonicalization) — callers pass every form they have
 * (raw input and resolved absolute) so boundary patterns can cover both.
 */
export function matchPathPattern(pattern: string, path: string): boolean {
    const p = pattern.trim();
    if (!GLOB_CHARS.test(p)) return p === path;
    return globToRegExp(p, true).test(path);
}

/**
 * Evaluate the bash rules for a command. Deny/ask match per segment and whole
 * string; allow must cover EVERY executed segment. Severity: deny > ask > allow.
 * Null = no rule matched (caller falls through to its existing behavior).
 */
export function evaluateBashRules(command: string, rules: PermissionRule[]): PermissionRule | null {
    const applicable = rules.filter((r) => r.tool === "bash" || r.tool === "*");
    for (const action of ["deny", "ask"] as const) {
        const hit = applicable.find(
            (r) => r.action === action && (!r.pattern || bashRuleMatchesSegments(r.pattern, command)),
        );
        if (hit) return hit;
    }
    return allowRuleCovering(
        command,
        applicable.filter((r) => r.action === "allow"),
    );
}

/**
 * The allow rule approving a command, when allow rules cover every segment
 * it runs. A bash glob's `*` crosses anything, `&&` included, so matching
 * the whole string alone let `Bash(git *)` approve `git status && rm -rf /`.
 */
function allowRuleCovering(command: string, allows: PermissionRule[]): PermissionRule | null {
    const unconditional = allows.find((r) => !r.pattern);
    if (unconditional) return unconditional;
    const segments = splitSegments(command);
    if (segments.length === 0) return null;
    const ruleFor = (segment: string) => allows.find((r) => matchBashPattern(r.pattern as string, segment));
    const covering = segments.map(ruleFor);
    return covering.every(Boolean) ? (covering[0] ?? null) : null;
}

/**
 * Evaluate path rules for a tool class against every known form of the path
 * (raw input + resolved absolute). Grep is additionally governed by read
 * rules (a path you may not read must not be searchable); pass both classes.
 */
export function evaluatePathRules(
    classes: PermissionToolClass[],
    paths: string[],
    rules: PermissionRule[],
): PermissionRule | null {
    const applicable = rules.filter((r) => r.tool === "*" || classes.includes(r.tool));
    const matches = (r: PermissionRule): boolean =>
        !r.pattern || paths.some((path) => matchPathPattern(r.pattern as string, path));
    for (const action of ["deny", "ask", "allow"] as const) {
        const hit = applicable.find((r) => r.action === action && matches(r));
        if (hit) return hit;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Dangerous commands
// ---------------------------------------------------------------------------

/**
 * Commands that prompt even when a remembered "always allow" grant covers
 * them — a saved `git` grant must not silently approve `git push`. An explicit
 * allow RULE in configuration does approve them (that's a deliberate, written
 * decision); this list only overrides remembered interactive grants.
 */
export const DANGEROUS_COMMANDS = ["rm", "chmod", "chown", "chgrp", "chattr", "pkill", "kill", "killall", "git push"];

/** True when any executed segment resolves to a dangerous command. */
export function isDangerousCommand(command: string): boolean {
    for (const segment of splitSegments(command)) {
        const resolved = resolveSegment(segment);
        if (!resolved) continue;
        if (DANGEROUS_COMMANDS.some((pattern) => segmentMatchesPattern(resolved, pattern))) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Rule sources
// ---------------------------------------------------------------------------

/** Directories whose project settings contribute rules: cwd up to (and
 * including) the git root; just cwd outside a repo. */
function ruleDirs(cwd: string): string[] {
    const dirs: string[] = [];
    let dir = cwd;
    for (;;) {
        dirs.push(dir);
        if (existsSync(join(dir, ".git"))) break;
        const parent = dirname(dir);
        if (parent === dir) return [cwd]; // no repo root found — cwd only
        dir = parent;
    }
    return dirs;
}

interface CachedRules {
    rules: PermissionRule[];
    at: number;
}

// Rules are re-read at most every 2s per cwd — live enough that settings
// edits apply without restart, cheap enough for per-tool-call evaluation.
const rulesCache = new Map<string, CachedRules>();
const RULES_CACHE_MS = 2000;

function readProjectPermissions(dir: string): PermissionRule[] {
    const file = join(dir, CONFIG_DIR_NAME, "settings.json");
    try {
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return [];
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { permissions?: PermissionsSetting };
        return parsePermissionsSetting(parsed?.permissions);
    } catch {
        return [];
    }
}

/**
 * The merged rule set for a working directory: global settings `permissions`
 * plus every trusted project's CONFIG_DIR/settings.json from cwd up to the
 * git root. Project rules are trust-gated like hooks and skills — an
 * untrusted cloned repo cannot grant itself allow rules.
 */
export function getPermissionRules(cwd: string): PermissionRule[] {
    const cached = rulesCache.get(cwd);
    if (cached && Date.now() - cached.at < RULES_CACHE_MS) return cached.rules;
    const rules = parsePermissionsSetting(getSetting("permissions"));
    if (isTrusted(cwd)) {
        for (const dir of ruleDirs(cwd)) rules.push(...readProjectPermissions(dir));
    }
    rulesCache.set(cwd, { rules, at: Date.now() });
    return rules;
}

/** Test seam: drop the rule cache so settings written mid-test apply. */
export function clearPermissionRulesCache(): void {
    rulesCache.clear();
}

// ---------------------------------------------------------------------------
// Path enforcement (shared by the file tools)
// ---------------------------------------------------------------------------

/**
 * Enforce path rules for one tool call: deny → throw, ask → interactive
 * approval (once-only; paths don't persist grants), no bridge → fail closed.
 * `paths` carries the forms the tool has (raw input + resolved absolute);
 * candidates are expanded so a rule matches whichever form it was written
 * for: absolute paths under cwd also match in their cwd-relative form (a
 * relative deny can't be dodged by calling with the absolute path), and
 * directory targets (`dir: true`) also match with a trailing `/`, so
 * searching `secrets` is governed by a `secrets/**` boundary.
 */
export async function enforcePathPermission(opts: {
    classes: PermissionToolClass[];
    paths: string[];
    cwd: string;
    /** Human label for refusals, e.g. "Reading `secrets/key.pem`". */
    what: string;
    /** The target is a directory being listed/searched. */
    dir?: boolean;
    signal?: AbortSignal;
}): Promise<void> {
    // Use the platform separator: on Windows a `C:\proj` cwd never prefixes as
    // `C:\proj/`, so the cwd-relative form was never generated and a relative
    // deny rule could be dodged by passing the absolute path. Rules are written
    // with forward slashes, so the relative form is offered both ways.
    const cwdPrefix = opts.cwd.endsWith(sep) ? opts.cwd : `${opts.cwd}${sep}`;
    const candidates = new Set<string>();
    for (const p of opts.paths) {
        candidates.add(p);
        if (p.startsWith(cwdPrefix)) {
            const rel = p.slice(cwdPrefix.length);
            candidates.add(rel);
            if (sep !== "/") candidates.add(rel.split(sep).join("/"));
        }
    }
    if (opts.dir) {
        for (const p of [...candidates]) {
            if (!p.endsWith("/")) candidates.add(`${p}/`);
        }
    }
    const rule = evaluatePathRules(opts.classes, [...candidates], getPermissionRules(opts.cwd));
    if (!rule || rule.action === "allow") return;
    if (rule.action === "deny") throw new Error(formatRuleDenyRefusal(opts.what, rule));
    // ask
    const bridge = getBashApprovalBridge();
    if (!bridge) throw new Error(formatAskUnavailableRefusal(opts.what, rule));
    const decision = await bridge.confirm(
        {
            kind: "path",
            command: opts.paths[opts.paths.length - 1] ?? "",
            cwd: opts.cwd,
            patterns: [],
            title: `rule ${rule.source} requires approval`,
        },
        { signal: opts.signal },
    );
    if (opts.signal?.aborted) throw new Error("Operation aborted");
    if (decision !== "once" && decision !== "always") {
        throw new Error(
            `The user reviewed this file access (${opts.what}) and declined it. ` +
                `Don't retry it or an equivalent. Continue the task without it, or explain what you needed it for.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Refusal for a deny rule — framed as settled policy so the model redirects
 * instead of hunting for a workaround (same voice as the denylist refusal). */
export function formatRuleDenyRefusal(what: string, rule: PermissionRule): string {
    return (
        `${what} is blocked by the permission rule \`${rule.source}\` — intentional, not an error. ` +
        `Don't retry it or an equivalent. If it's truly required, ask the user to adjust their permission rules; ` +
        `otherwise continue without it.`
    );
}

/** Refusal when an ask rule matches but no interactive prompt is available
 * (print mode / RPC): fail closed and tell the model why. */
export function formatAskUnavailableRefusal(what: string, rule: PermissionRule): string {
    return (
        `${what} matches the permission rule \`${rule.source}\`, which requires interactive user approval — ` +
        `unavailable in this non-interactive run. Continue without it, or ask the user to run this step themselves.`
    );
}
