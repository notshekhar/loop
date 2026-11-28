/**
 * The approval gate every shell command passes before it runs: the denylist,
 * permission rules, remembered "always allow" grants, the workspace
 * context-file guard and the opt-in bashApprove prompt. loop's own bash tool
 * runs it, and so do native agents (Claude Code's Bash) that route their
 * permission requests through loop — one set of rules, one memory of what the
 * user allowed, whichever agent asked.
 *
 * Throws the refusal the model should read; resolves when the command may run.
 */
import { getSetting, setSetting } from "../../settings";
import { canonicalProjectDir } from "../../agent/trust";
import { addProjectBashAllow, getProjectBashAllow } from "../../sessions/projects";
import { getBashApprovalBridge, type BashApprovalBridge } from "../approval-bridge";
import {
    DEFAULT_BASH_DENY,
    denyPattern,
    findDeniedCommand,
    formatApprovalRefusal,
    formatDenyRefusal,
    isCommandAllowed,
    suggestAllowPatterns,
} from "./command-deny";
import { findContextFileDeletion, formatContextFileRefusal } from "./context-file-guard";
import {
    evaluateBashRules,
    formatAskUnavailableRefusal,
    formatRuleDenyRefusal,
    getPermissionRules,
    isDangerousCommand,
} from "./permission-rules";

export interface BashGateContext {
    cwd: string;
    signal?: AbortSignal;
    /**
     * Ask even with bashApprove off. For a native agent in plan mode: loop's
     * own bash runs read-only while planning, an agent's shell does not, so
     * the user is the only thing keeping a planning agent's command harmless.
     */
    alwaysAsk?: boolean;
}

export async function gateBashCommand(command: string, ctx: BashGateContext): Promise<void> {
    // Denylist guardrail: refuse blocked commands before anything runs.
    // Read live so settings edits apply without a restart; an unset
    // bashDeny falls back to the seeded defaults. Checked against the
    // raw command (before commandPrefix) so the user's text is judged.
    const denied = findDeniedCommand(command, currentDenyList());
    if (denied) throw new Error(formatDenyRefusal(denied));

    // Permission rules (settings `permissions` + trusted project files):
    // deny > ask > allow, judged against the raw command like the
    // denylist. Deny/ask match per executed segment; allow matches the
    // whole string only, so an allowed prefix can't smuggle segments.
    const ruleVerdict = evaluateBashRules(command, getPermissionRules(ctx.cwd));
    const commandLabel = `\`${command.split("\n")[0].slice(0, 80)}\``;
    if (ruleVerdict?.action === "deny") throw new Error(formatRuleDenyRefusal(commandLabel, ruleVerdict));
    // ruleVerdict "allow": explicit configuration — skip all prompting.
    if (ruleVerdict?.action === "allow") return;

    const bridge = getBashApprovalBridge();
    const remembered = isRemembered(command, ctx.cwd);
    const prompt = (title?: string) => promptForCommand(bridge, command, ctx, title);

    // Workspace context files (AGENTS.md / CLAUDE.md) are never
    // deleted or moved on the model's initiative: prompt when
    // interactive, fail closed otherwise. Remembered grants don't
    // satisfy this (like other dangerous commands); only an explicit
    // whole-command allow rule in configuration skips it.
    const contextHit = findContextFileDeletion(command);
    if (contextHit) {
        if (!bridge) throw new Error(formatContextFileRefusal(contextHit));
        return prompt(`deletes workspace context file ${contextHit.file}`);
    }
    if (ruleVerdict?.action === "ask") {
        // An ask rule forces a prompt in every mode — even when the
        // bashApprove setting is off. A remembered grant satisfies it
        // (grok parity) unless the command is dangerous. Without an
        // interactive bridge (print mode / RPC) it fails closed.
        if (remembered) return;
        if (!bridge) throw new Error(formatAskUnavailableRefusal(commandLabel, ruleVerdict));
        return prompt(`rule ${ruleVerdict.source} requires approval`);
    }
    // No rule matched: the opt-in bashApprove policy (default off)
    // prompts for anything not remembered. Needs the interactive
    // bridge — the setting is inert in print mode / RPC. Subagent
    // bash goes through this same tool, so the safeguard covers
    // delegation too.
    const asking = ctx.alwaysAsk === true || getSetting("bashApprove") === true;
    if (asking && bridge && !remembered) return prompt();
}

function currentDenyList(): string[] {
    return getSetting("bashDeny") ?? DEFAULT_BASH_DENY;
}

/**
 * Remembered "always allow" grants: per-project (the approval
 * prompt's persistence) plus the legacy global bashAllow list. A
 * dangerous command (rm, git push, kill, …) never rides a
 * remembered grant — it prompts again; only an explicit allow RULE
 * in configuration approves it silently.
 */
function isRemembered(command: string, cwd: string): boolean {
    const grants = [
        ...getProjectBashAllow(canonicalProjectDir(cwd)),
        ...(getSetting("bashAllow") ?? []).map(denyPattern).filter((p) => p.length > 0),
    ];
    return isCommandAllowed(command, grants) && !isDangerousCommand(command);
}

/**
 * Show the approval prompt and apply the decision. "always" persists
 * per-project allow grants; "never" persists the same patterns into the
 * bashDeny guardrail.
 */
async function promptForCommand(
    bridge: BashApprovalBridge | null,
    command: string,
    ctx: BashGateContext,
    title?: string,
): Promise<void> {
    if (!bridge) return; // no UI — callers gate on bridge first
    const patterns = suggestAllowPatterns(command);
    const decision = await bridge.confirm(
        { kind: "bash", command, cwd: ctx.cwd, patterns, title },
        { signal: ctx.signal },
    );
    if (ctx.signal?.aborted) throw new Error("Command aborted");
    if (decision === "never") {
        const denyList = currentDenyList()
            .map(denyPattern)
            .filter((p) => p.length > 0);
        setSetting("bashDeny", [...denyList, ...patterns.filter((p) => !denyList.includes(p))]);
        throw new Error(formatApprovalRefusal(command));
    }
    if (decision === "deny") throw new Error(formatApprovalRefusal(command));
    if (decision === "always" && patterns.length > 0) addProjectBashAllow(canonicalProjectDir(ctx.cwd), patterns);
}
