import { getBashApprovalBridge } from "../../tools/approval-bridge";
import { gateBashCommand } from "../../tools/utils/bash-gate";
import type { RpcParams } from "./codex-rpc";
import type { NativeAgentTurnContext } from "./shared";
import { unwrapShell } from "./tool-map";

/**
 * Codex's approval requests, answered the way loop answers its own: a command
 * goes through loop's bash gate (denylist, rules, the project's remembered
 * grants, the prompt), a file change through loop's prompt — with "always"
 * meaning Codex stops asking for edits for the rest of its session.
 *
 * Anything else Codex might ask (user input, MCP elicitation, extra
 * permissions) has no loop surface yet: it is refused with an error, which
 * Codex treats as a "no" rather than waiting forever.
 */
export async function answerCodexRequest(
    method: string,
    params: RpcParams,
    ctx: NativeAgentTurnContext | undefined,
    signal: AbortSignal | undefined,
): Promise<unknown> {
    switch (method) {
        case "item/commandExecution/requestApproval":
            // Codex asks about the shell wrapper it runs (`/bin/zsh -lc '…'`);
            // judged as-is, "always allow" would remember `zsh` — every command.
            return { decision: await approveCommand(unwrapShell(String(params.command ?? "")), ctx, signal) };
        case "item/fileChange/requestApproval":
            return { decision: await approveFileChange(params, ctx, signal) };
        default:
            throw new Error(`loop does not answer ${method}`);
    }
}

async function approveCommand(
    command: string,
    ctx: NativeAgentTurnContext | undefined,
    signal: AbortSignal | undefined,
): Promise<"accept" | "decline"> {
    if (!ctx) return "decline";
    try {
        await gateBashCommand(command, { cwd: ctx.cwd, signal });
        return "accept";
    } catch {
        return "decline";
    }
}

async function approveFileChange(
    params: RpcParams,
    ctx: NativeAgentTurnContext | undefined,
    signal: AbortSignal | undefined,
): Promise<"accept" | "acceptForSession" | "decline"> {
    if (!ctx) return "decline";
    const bridge = getBashApprovalBridge();
    if (!bridge) return "accept";
    const reason = typeof params.reason === "string" && params.reason ? params.reason : undefined;
    const decision = await bridge.confirm(
        {
            kind: "tool",
            command: reason ?? "apply a file change",
            cwd: ctx.cwd,
            patterns: ["file changes, for the rest of this Codex session"],
            title: "Codex wants to change files",
        },
        { signal },
    );
    if (decision === "always") return "acceptForSession";
    return decision === "once" ? "accept" : "decline";
}
