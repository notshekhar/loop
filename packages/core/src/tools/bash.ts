import { PRODUCT_NAME } from "../brand";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import { waitForChildProcess } from "./utils/child-process";
import {
    getShellConfig,
    getShellEnv,
    killProcessTree,
    trackDetachedChildPid,
    untrackDetachedChildPid,
} from "./utils/shell";
import { OutputAccumulator } from "./utils/output-accumulator";
import {
    MAX_BACKGROUND_SHELLS,
    isShellPanelPresent,
    registerShell,
    runningShellCount,
    type ShellInfo,
} from "./utils/shell-registry";
import { DEFAULT_MAX_BYTES, formatSize } from "./utils/truncate";
import {
    DEFAULT_BASH_DENY,
    denyPattern,
    findDeniedCommand,
    formatApprovalRefusal,
    formatDenyRefusal,
    isCommandAllowed,
    suggestAllowPatterns,
} from "./utils/command-deny";
import {
    evaluateBashRules,
    formatAskUnavailableRefusal,
    formatRuleDenyRefusal,
    getPermissionRules,
    isDangerousCommand,
} from "./utils/permission-rules";
import { findContextFileDeletion, formatContextFileRefusal } from "./utils/context-file-guard";
import { getBashApprovalBridge } from "./approval-bridge";
import { isPlanModeActive } from "./utils/plan-mode";
import { getSetting, setSetting } from "../settings";
import { canonicalProjectDir } from "../agent/trust";
import { addProjectBashAllow, getProjectBashAllow } from "../sessions/projects";
import { sandbox, type SandboxConfig } from "@notshekhar/loop-sandbox";

/**
 * Default and ceiling for the bash timeout, in seconds. A command with no
 * explicit `timeout` is capped at the default so a hung process (a server left
 * in the foreground, a command waiting on stdin) can't run unbounded — the bug
 * where a forgotten command ran for 30+ minutes. The model may pass a larger
 * `timeout` for genuinely long work (builds, installs), but never above the max.
 */
export const DEFAULT_BASH_TIMEOUT_SEC = 120;
export const MAX_BASH_TIMEOUT_SEC = 600;

/**
 * Resolve the effective bash timeout (seconds): fall back to the default when
 * unset/non-positive, and clamp to the max. Guarantees every run is bounded.
 */
export function resolveBashTimeout(timeout?: number): number {
    const base = timeout && timeout > 0 ? timeout : DEFAULT_BASH_TIMEOUT_SEC;
    return Math.min(base, MAX_BASH_TIMEOUT_SEC);
}

export interface BashToolContext {
    cwd: string;
    abortSignal?: AbortSignal;
    /** Optional explicit shell path (settings.json `shellPath`) */
    shellPath?: string;
    /** Optional command prefix prepended to every command (e.g. shell setup) */
    commandPrefix?: string;
    /** Scopes plan-mode lookups (see tools/index.ts ToolContext). */
    sessionId?: string;
    /**
     * Force a fail-closed, kernel-enforced read-only sandbox (no writable cwd),
     * regardless of user sandbox settings. Set for read-only agents (plan): if
     * the sandbox can't be enforced, the command is REFUSED rather than run.
     * Plan mode (see utils/plan-mode.ts) forces the same path live.
     */
    readOnlyFs?: boolean;
    /**
     * Fail-closed sandbox whose only writable place is `cwd`, regardless of
     * user sandbox settings — for an app whose bash may write to a scratch
     * directory and nowhere else. Refused, like readOnlyFs, when it can't hold.
     * `denyRead`/`allowRead` narrow what it may read, as in the sandbox setting.
     */
    confineToCwd?: { network: SandboxConfig["network"]; denyRead?: string[]; allowRead?: string[] };
}

interface SpawnOptions {
    env?: NodeJS.ProcessEnv;
    shellPath?: string;
    /** Pre-built spawn argv (sandbox wrapper). When set, `command` is ignored. */
    argv?: string[];
}

/**
 * Spawn the command, shared by the foreground and background paths so a
 * background shell gets the same shell resolution, PATH and sandbox wrapper as
 * a foreground one. Throws if the cwd is gone.
 */
function spawnBash(command: string, cwd: string, opts: SpawnOptions) {
    if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
    }
    // Sandbox path: spawn the wrapper argv directly (no host shell layer).
    // Otherwise spawn the command through the configured shell as before.
    let file: string;
    let spawnArgs: string[];
    if (opts.argv && opts.argv.length > 0) {
        file = opts.argv[0];
        spawnArgs = opts.argv.slice(1);
    } else {
        const { shell, args } = getShellConfig(opts.shellPath);
        file = shell;
        spawnArgs = [...args, command];
    }
    const child = spawn(file, spawnArgs, {
        cwd,
        detached: process.platform !== "win32",
        env: opts.env ?? getShellEnv(),
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) trackDetachedChildPid(child.pid);
    return child;
}

/** Foreground result: the command finished, or it was promoted to a shell. */
type ExecResult = { exitCode: number | null; promoted?: undefined } | { exitCode?: undefined; promoted: ShellInfo };

function execBash(
    command: string,
    cwd: string,
    opts: SpawnOptions & {
        onData: (d: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        /**
         * Called instead of killing when the timeout fires. Returning a shell
         * hands the still-running child over to the registry — the run keeps
         * going in the background rather than dying at the deadline. Returning
         * undefined keeps the old behaviour (kill the tree, report a timeout).
         */
        onTimeout?: (child: ReturnType<typeof spawnBash>) => ShellInfo | undefined;
    },
): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        let child: ReturnType<typeof spawnBash>;
        try {
            child = spawnBash(command, cwd, opts);
        } catch (err) {
            reject(err);
            return;
        }
        let timedOut = false;
        let promotedTo: ShellInfo | undefined;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const onAbort = () => {
            if (child.pid) killProcessTree(child.pid);
        };
        if (opts.timeout !== undefined && opts.timeout > 0) {
            timeoutHandle = setTimeout(() => {
                // Hand the live child to the registry if we can. Everything the
                // foreground had wired must come off first: our data listeners
                // (the registry owns the stream now) and the abort listener
                // (the next esc ends the TURN, and must not reach through it to
                // kill a shell the user can now see and manage).
                const promote = opts.onTimeout?.(child);
                if (promote) {
                    promotedTo = promote;
                    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
                    resolve({ promoted: promote });
                    return;
                }
                timedOut = true;
                if (child.pid) killProcessTree(child.pid);
            }, opts.timeout * 1000);
        }
        child.stdout?.on("data", opts.onData);
        child.stderr?.on("data", opts.onData);
        if (opts.signal) {
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        waitForChildProcess(child)
            .then((code) => {
                // Promoted: the registry owns this child's exit now, and the
                // promise above has already settled.
                if (promotedTo) return;
                if (child.pid) untrackDetachedChildPid(child.pid);
                if (timeoutHandle) clearTimeout(timeoutHandle);
                if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
                if (opts.signal?.aborted) {
                    reject(new Error("aborted"));
                    return;
                }
                if (timedOut) {
                    reject(new Error(`timeout:${opts.timeout}`));
                    return;
                }
                resolve({ exitCode: code });
            })
            .catch((err) => {
                if (promotedTo) return;
                if (child.pid) untrackDetachedChildPid(child.pid);
                if (timeoutHandle) clearTimeout(timeoutHandle);
                if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
                reject(err);
            });
    });
}

const NO_EXTRA_PATHS: SandboxConfig["filesystem"] = { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] };
const READ_ONLY: SandboxConfig = { filesystem: { ...NO_EXTRA_PATHS, readOnly: true }, network: "deny" };

/**
 * Wrap a command in a sandbox that MUST hold: when it can't be applied the
 * command is refused, never run unsandboxed. `what` completes "<what>, which
 * isn't available…", so the model learns why bash is gone.
 */
async function enforceSandbox(
    command: string,
    ctx: BashToolContext,
    what: string,
    config: SandboxConfig,
): Promise<string[]> {
    if (!sandbox.isSupported()) {
        throw new Error(
            `${what}, which isn't available on this platform — bash is disabled here. Investigate with read/ls/grep/find instead.`,
        );
    }
    const deps = sandbox.checkDependencies();
    if (deps.errors.length > 0) {
        throw new Error(
            `${what}, but it's unavailable (${deps.errors.join(", ")}). Refusing to run bash unsandboxed. Use read/ls/grep/find, or install the missing dependency.`,
        );
    }
    const { shell } = getShellConfig(ctx.shellPath);
    try {
        const wrapped = await sandbox.wrap({ command, shell, cwd: ctx.cwd, config });
        if (!wrapped) throw new Error("sandbox could not wrap the command");
        return wrapped.argv;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`The sandbox failed to start (${msg}). Refusing to run bash unsandboxed.`);
    }
}

/**
 * Decide how to run a command under the sandbox. Returns a spawn argv when the
 * sandbox is active, or a warning when it's enabled but can't be enforced.
 *
 * Fail-open by design (the user's configured behavior): if the boundary can't
 * be applied we still run the command, but surface a warning so it's never a
 * silent downgrade. `command` is the final command (after commandPrefix).
 */
async function resolveSandbox(command: string, ctx: BashToolContext): Promise<{ argv?: string[]; warning?: string }> {
    // Read-only agents (e.g. plan) and active plan mode: bash MUST be
    // kernel-enforced read-only, and fail CLOSED — if the sandbox can't be
    // applied, refuse rather than run unsandboxed. (Plan only gets bash on
    // sandbox-capable platforms, so the unsupported branch is defensive.)
    // Plan mode is checked live (not at tool creation) so the gate applies
    // the moment enter_plan_mode is approved, mid-turn.
    if (ctx.readOnlyFs || isPlanModeActive(ctx.sessionId)) {
        const who = ctx.readOnlyFs ? "This agent runs" : "Plan mode runs";
        return { argv: await enforceSandbox(command, ctx, `${who} bash in a read-only OS sandbox`, READ_ONLY) };
    }
    if (ctx.confineToCwd) {
        return {
            argv: await enforceSandbox(
                command,
                ctx,
                "bash here runs in an OS sandbox that can only write to its working directory",
                {
                    filesystem: {
                        ...NO_EXTRA_PATHS,
                        denyRead: ctx.confineToCwd.denyRead ?? [],
                        allowRead: ctx.confineToCwd.allowRead ?? [],
                    },
                    network: ctx.confineToCwd.network,
                },
            ),
        };
    }

    const s = getSetting("sandbox");
    if (!s?.enabled) return {};

    if (!sandbox.isSupported()) {
        return { warning: "sandbox is enabled but not supported on this platform — ran WITHOUT isolation." };
    }
    const deps = sandbox.checkDependencies();
    if (deps.errors.length > 0) {
        return { warning: `sandbox is enabled but unavailable (${deps.errors.join(", ")}) — ran WITHOUT isolation.` };
    }

    const { shell } = getShellConfig(ctx.shellPath);
    const config: SandboxConfig = {
        filesystem: {
            allowWrite: s.allowWrite ?? [],
            denyWrite: s.denyWrite ?? [],
            denyRead: s.denyRead ?? [],
            allowRead: s.allowRead ?? [],
            allowGitConfig: s.allowGitConfig,
        },
        network: s.network ?? "deny",
    };
    try {
        const wrapped = await sandbox.wrap({ command, shell, cwd: ctx.cwd, config });
        if (!wrapped) return { warning: "sandbox could not wrap the command — ran WITHOUT isolation." };
        return { argv: wrapped.argv };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { warning: `sandbox failed to start (${msg}) — ran WITHOUT isolation.` };
    }
}

export function createBashTool(ctx: BashToolContext) {
    return tool({
        description: `Execute a bash command. Returns merged stdout/stderr. Output truncated to 50KB / 2000 lines (tail kept). Process tree killed on abort/timeout. Timeout is in seconds — defaults to ${DEFAULT_BASH_TIMEOUT_SEC}s, max ${MAX_BASH_TIMEOUT_SEC}s; pass a larger value for long-running work like builds or installs.

Set run_in_background for a command that is not supposed to finish — a dev server, a watcher, a tail. It returns a shell id immediately and keeps running while you work; read it with the \`shells\` tool. You are told when it exits, so never sleep or poll in a loop waiting for one. Do NOT background a command whose output you need in order to take the next step, and never background it by writing \`&\` or \`nohup\` yourself — a command backgrounded that way is invisible and cannot be read or killed.`,
        inputSchema: z.object({
            command: z.string().describe("Bash command to execute"),
            timeout: z
                .number()
                .positive()
                .optional()
                .describe(
                    `Timeout in seconds. Defaults to ${DEFAULT_BASH_TIMEOUT_SEC}, capped at ${MAX_BASH_TIMEOUT_SEC}. Ignored when run_in_background is set.`,
                ),
            run_in_background: z
                .boolean()
                .optional()
                .describe(
                    "Run without waiting: returns a shell id straight away and the command keeps running. Use for servers, watchers and tails.",
                ),
        }),
        execute: async ({ command, timeout, run_in_background }, options) => {
            // Always bound the run: an omitted timeout falls back to the default,
            // and any value (default or model-supplied) is clamped to the max, so
            // a command can never run unbounded.
            const effectiveTimeout = resolveBashTimeout(timeout);
            const background = run_in_background === true;
            if (background) {
                if (getSetting("backgroundShells") !== true) {
                    throw new Error(
                        "Background shells are off (the backgroundShells setting is opt-in). Run the command in the foreground, with a longer timeout if it needs one.",
                    );
                }
                // A read-only planning agent must not be able to leave daemons
                // behind: plan mode ends, the process does not.
                if (ctx.readOnlyFs || isPlanModeActive(ctx.sessionId)) {
                    throw new Error(
                        "Background shells are not available here — this agent runs bash read-only and must not leave processes running. Run the command in the foreground, or leave it for after plan mode.",
                    );
                }
                if (runningShellCount(ctx.sessionId) >= MAX_BACKGROUND_SHELLS) {
                    throw new Error(
                        `Too many background shells (${MAX_BACKGROUND_SHELLS} already running). Kill one with the shells tool before starting another.`,
                    );
                }
            }
            // Denylist guardrail: refuse blocked commands before anything runs.
            // Read live so settings edits apply without a restart; an unset
            // bashDeny falls back to the seeded defaults. Checked against the
            // raw command (before commandPrefix) so the user's text is judged.
            const denied = findDeniedCommand(command, getSetting("bashDeny") ?? DEFAULT_BASH_DENY);
            if (denied) throw new Error(formatDenyRefusal(denied));

            // Permission rules (settings `permissions` + trusted project files):
            // deny > ask > allow, judged against the raw command like the
            // denylist. Deny/ask match per executed segment; allow matches the
            // whole string only, so an allowed prefix can't smuggle segments.
            const rules = getPermissionRules(ctx.cwd);
            const ruleVerdict = evaluateBashRules(command, rules);
            const commandLabel = `\`${command.split("\n")[0].slice(0, 80)}\``;
            if (ruleVerdict?.action === "deny") throw new Error(formatRuleDenyRefusal(commandLabel, ruleVerdict));

            const signal = options?.abortSignal ?? ctx.abortSignal;
            const bridge = getBashApprovalBridge();
            const projectDir = canonicalProjectDir(ctx.cwd);

            // Remembered "always allow" grants: per-project (the approval
            // prompt's persistence) plus the legacy global bashAllow list. A
            // dangerous command (rm, git push, kill, …) never rides a
            // remembered grant — it prompts again; only an explicit allow RULE
            // in configuration approves it silently.
            const grants = [
                ...getProjectBashAllow(projectDir),
                ...(getSetting("bashAllow") ?? []).map(denyPattern).filter((p) => p.length > 0),
            ];
            const remembered = isCommandAllowed(command, grants) && !isDangerousCommand(command);

            // Show the approval prompt and apply the decision. "always"
            // persists per-project allow grants; "never" persists the same
            // patterns into the bashDeny guardrail.
            const promptUser = async (title?: string): Promise<void> => {
                if (!bridge) return; // no UI — callers gate on bridge first
                const patterns = suggestAllowPatterns(command);
                const decision = await bridge.confirm(
                    { kind: "bash", command, cwd: ctx.cwd, patterns, title },
                    { signal },
                );
                if (signal?.aborted) throw new Error("Command aborted");
                if (decision === "never") {
                    const denyList = (getSetting("bashDeny") ?? DEFAULT_BASH_DENY)
                        .map(denyPattern)
                        .filter((p) => p.length > 0);
                    setSetting("bashDeny", [...denyList, ...patterns.filter((p) => !denyList.includes(p))]);
                    throw new Error(formatApprovalRefusal(command));
                }
                if (decision === "deny") throw new Error(formatApprovalRefusal(command));
                if (decision === "always" && patterns.length > 0) addProjectBashAllow(projectDir, patterns);
            };

            // Workspace context files (AGENTS.md / CLAUDE.md) are never
            // deleted or moved on the model's initiative: prompt when
            // interactive, fail closed otherwise. Remembered grants don't
            // satisfy this (like other dangerous commands); only an explicit
            // whole-command allow rule in configuration skips it.
            const contextHit = ruleVerdict?.action !== "allow" ? findContextFileDeletion(command) : null;
            if (contextHit) {
                if (!bridge) throw new Error(formatContextFileRefusal(contextHit));
                await promptUser(`deletes workspace context file ${contextHit.file}`);
            } else if (ruleVerdict?.action === "ask") {
                // An ask rule forces a prompt in every mode — even when the
                // bashApprove setting is off. A remembered grant satisfies it
                // (grok parity) unless the command is dangerous. Without an
                // interactive bridge (print mode / RPC) it fails closed.
                if (!remembered) {
                    if (!bridge) throw new Error(formatAskUnavailableRefusal(commandLabel, ruleVerdict));
                    await promptUser(`rule ${ruleVerdict.source} requires approval`);
                }
            } else if (ruleVerdict?.action !== "allow") {
                // No rule matched: the opt-in bashApprove policy (default off)
                // prompts for anything not remembered. Needs the interactive
                // bridge — the setting is inert in print mode / RPC. Subagent
                // bash goes through this same tool, so the safeguard covers
                // delegation too.
                if (getSetting("bashApprove") === true && bridge && !remembered) {
                    await promptUser();
                }
            }
            // ruleVerdict "allow": explicit configuration — skip all prompting.
            const output = new OutputAccumulator({ tempFilePrefix: "loop-bash" });
            // Named so promotion can detach it: the registry takes the stream
            // over, and two writers on one child duplicate every chunk.
            const onData = (d: Buffer) => output.append(d);
            const finalCommand = ctx.commandPrefix ? `${ctx.commandPrefix}\n${command}` : command;

            // Resolve the sandbox against the final command (commandPrefix included).
            const sandboxRun = await resolveSandbox(finalCommand, ctx);
            const withSandboxWarning = (text: string): string =>
                sandboxRun.warning ? appendStatus(`[${PRODUCT_NAME} sandbox] ${sandboxRun.warning}`, text) : text;

            const formatOutput = async (emptyText = "(no output)"): Promise<{ text: string; truncated: boolean }> => {
                output.finish();
                const snap = output.snapshot({ persistIfTruncated: true });
                await output.closeTempFile();
                let text = snap.content || emptyText;
                const t = snap.truncation;
                if (t.truncated) {
                    const startLine = t.totalLines - t.outputLines + 1;
                    const endLine = t.totalLines;
                    // Absent when the full-output file could not be written (an
                    // unwritable TMPDIR, a full disk). The truncation notice is
                    // still true and still worth printing — it just has nowhere
                    // to send anyone for the rest, and naming a path that was
                    // never written would be worse than naming none.
                    const fullOutput = snap.fullOutputPath ? ` Full output: ${snap.fullOutputPath}` : "";
                    if (t.lastLinePartial) {
                        text += `\n\n[Showing last ${formatSize(t.outputBytes)} of line ${endLine} (line is ${formatSize(output.getLastLineBytes())}).${fullOutput}]`;
                    } else if (t.truncatedBy === "lines") {
                        text += `\n\n[Showing lines ${startLine}-${endLine} of ${t.totalLines}.${fullOutput}]`;
                    } else {
                        text += `\n\n[Showing lines ${startLine}-${endLine} of ${t.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${fullOutput}]`;
                    }
                }
                return { text, truncated: t.truncated };
            };

            const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

            // Background: spawn, hand it to the registry, return the id. The
            // turn's abort signal is deliberately NOT wired — esc ends the
            // turn, and must not take the user's dev server with it.
            if (background) {
                const child = spawnBash(finalCommand, ctx.cwd, {
                    shellPath: ctx.shellPath,
                    argv: sandboxRun.argv,
                });
                const info = registerShell({
                    sessionId: ctx.sessionId,
                    command,
                    cwd: ctx.cwd,
                    child,
                });
                await output.closeTempFile();
                return withSandboxWarning(
                    `Started ${info.id} in the background (pid ${info.pid ?? "?"}).\nRead its output with shells({ action: "output", id: "${info.id}" }). You will be told when it exits.`,
                );
            }

            try {
                const result = await execBash(finalCommand, ctx.cwd, {
                    onData,
                    signal,
                    timeout: effectiveTimeout,
                    shellPath: ctx.shellPath,
                    argv: sandboxRun.argv,
                    onTimeout: (child) => {
                        // Promotion instead of death — but only where the shells
                        // panel will show it. The timeout exists to stop an
                        // invisible long run; without a surface listing it, a
                        // promoted shell is exactly that invisible run again.
                        if (getSetting("backgroundShells") !== true) return undefined;
                        if (!isShellPanelPresent()) return undefined;
                        if (runningShellCount(ctx.sessionId) >= MAX_BACKGROUND_SHELLS) return undefined;
                        child.stdout?.removeListener("data", onData);
                        child.stderr?.removeListener("data", onData);
                        output.finish();
                        const seed = output.snapshot().content;
                        return registerShell({
                            sessionId: ctx.sessionId,
                            command,
                            cwd: ctx.cwd,
                            child,
                            seed,
                            promoted: true,
                        });
                    },
                });
                if (result.promoted) {
                    await output.closeTempFile();
                    const info = result.promoted;
                    return withSandboxWarning(
                        `Still running after ${effectiveTimeout}s, so it was moved to the background as ${info.id} (pid ${info.pid ?? "?"}) rather than killed.\nRead it with shells({ action: "output", id: "${info.id}" }), or kill it with shells({ action: "kill", id: "${info.id}" }). You will be told when it exits.`,
                    );
                }
                const { exitCode } = result;
                const { text } = await formatOutput();
                if (exitCode !== 0 && exitCode !== null) {
                    throw new Error(withSandboxWarning(appendStatus(text, `Command exited with code ${exitCode}`)));
                }
                return withSandboxWarning(text);
            } catch (err) {
                if (err instanceof Error && err.message === "aborted") {
                    const { text } = await formatOutput("");
                    throw new Error(withSandboxWarning(appendStatus(text, "Command aborted")));
                }
                if (err instanceof Error && err.message.startsWith("timeout:")) {
                    const secs = err.message.split(":")[1];
                    const { text } = await formatOutput("");
                    throw new Error(withSandboxWarning(appendStatus(text, `Command timed out after ${secs} seconds`)));
                }
                throw err;
            }
        },
    });
}
