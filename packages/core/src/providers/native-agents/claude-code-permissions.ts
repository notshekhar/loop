import type { CanUseTool, Options as ClaudeOptions, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { getBashApprovalBridge } from "../../tools/approval-bridge";
import { gateBashCommand } from "../../tools/utils/bash-gate";
import { stringify, type NativeAgentTurnContext } from "./shared";

/**
 * Claude Code's permission requests, answered the way loop answers its own:
 *
 * - `Bash` goes through loop's bash gate — the denylist, permission rules,
 *   the project's remembered "always allow" grants — so a command allowed
 *   once for loop is allowed for Claude Code too, and the reverse.
 * - Every other tool gets loop's prompt with Claude's own suggested rules
 *   (`Edit(src/**)`) as the "always allow" choice; Claude Code keeps them.
 *   There is no "never" here: the SDK saves rules only with an allow.
 */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function permissionOptions(ctx: NativeAgentTurnContext | undefined): Partial<ClaudeOptions> {
    if (!ctx) return { permissionMode: "default", tools: [] };
    if (ctx.planMode) return { permissionMode: "plan", canUseTool: approvalCallback(ctx) };
    if (ctx.approvals && getBashApprovalBridge()) return { permissionMode: "default", canUseTool: approvalCallback(ctx) };
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
}

function approvalCallback(ctx: NativeAgentTurnContext): CanUseTool {
    return async (toolName, input, { signal, toolUseID, suggestions, title }) => {
        if (toolName === "ExitPlanMode" && ctx.planMode) {
            return deny("Plan mode is on in loop. Present the final plan and stop; the user will switch modes.", toolUseID);
        }
        if (toolName === "Bash") return approveCommand(String(input.command ?? ""), ctx, signal, toolUseID, input);
        return approveTool(toolName, input, { ctx, signal, toolUseID, suggestions: suggestions ?? [], title });
    };
}

async function approveCommand(
    command: string,
    ctx: NativeAgentTurnContext,
    signal: AbortSignal,
    toolUseID: string,
    input: Record<string, unknown>,
): Promise<PermissionResult> {
    try {
        await gateBashCommand(command, { cwd: ctx.cwd, signal, alwaysAsk: ctx.planMode });
        return { behavior: "allow", updatedInput: input, toolUseID };
    } catch (err) {
        return deny(err instanceof Error ? err.message : String(err), toolUseID);
    }
}

async function approveTool(
    toolName: string,
    input: Record<string, unknown>,
    req: { ctx: NativeAgentTurnContext; signal: AbortSignal; toolUseID: string; suggestions: PermissionUpdate[]; title?: string },
): Promise<PermissionResult> {
    const bridge = getBashApprovalBridge();
    if (!bridge) return { behavior: "allow", updatedInput: input, toolUseID: req.toolUseID };
    const isEdit = EDIT_TOOLS.has(toolName);
    const decision = await bridge.confirm(
        {
            kind: "tool",
            command: isEdit
                ? String(input.file_path ?? input.notebook_path ?? "")
                : `${toolName} ${stringify(input).slice(0, 400)}`,
            cwd: req.ctx.cwd,
            patterns: describeUpdates(req.suggestions),
            title: req.title ?? `Claude Code wants to use ${toolName}`,
        },
        { signal: req.signal },
    );
    switch (decision) {
        case "once":
            return { behavior: "allow", updatedInput: input, toolUseID: req.toolUseID };
        case "always":
            return { behavior: "allow", updatedInput: input, updatedPermissions: req.suggestions, toolUseID: req.toolUseID };
        default:
            return deny("The user declined this tool call.", req.toolUseID);
    }
}

function deny(message: string, toolUseID: string): PermissionResult {
    return { behavior: "deny", message, toolUseID };
}

/** What each suggestion would remember, as the prompt lists it. */
export function describeUpdates(updates: readonly PermissionUpdate[]): string[] {
    const out: string[] = [];
    for (const u of updates) {
        if (u.type === "addRules" || u.type === "replaceRules") {
            for (const r of u.rules) out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
        } else if (u.type === "addDirectories") {
            for (const d of u.directories) out.push(`access to ${d}`);
        }
    }
    return out;
}
