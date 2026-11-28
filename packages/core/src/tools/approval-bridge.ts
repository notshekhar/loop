/**
 * UI bridge for tool approval prompts. Core cannot depend on the CLI's TUI,
 * so the interactive confirm flow is injected here at startup, exactly like
 * the ask tool's bridge. The registry doubles as the availability signal:
 * print mode / RPC never register a bridge, so prompting features are inert
 * there (ask permission rules fail closed with a refusal instead).
 *
 * One bridge serves every prompt kind — bash commands (the original
 * bashApprove flow), path-rule prompts on file tools, the plan-mode
 * entry/exit confirmations, and a native agent's own tools (Claude Code's
 * Edit, WebFetch, MCP calls…) — distinguished by `kind` so the UI can word
 * each one.
 */

/**
 * "tool": a native agent's tool call. Its `patterns` are the agent's own
 * permission rules (`Edit(src/**)`), which the AGENT remembers on
 * always/never — loop persists nothing for this kind.
 */
export type ApprovalKind = "bash" | "path" | "plan" | "exit-plan" | "tool";

export interface BashApprovalRequest {
    /** What kind of approval this is; absent = "bash" (pre-kind callers). */
    kind?: ApprovalKind;
    /** The raw command the model asked to run (pre commandPrefix), the file
     * path being touched, or a plan-mode entry/exit summary — per `kind`. */
    command: string;
    /** Working directory the command would run in. */
    cwd: string;
    /** Patterns "always allow" / "never allow" would persist (shown so the
     * choice is informed). Empty = only once/deny offered. */
    patterns: string[];
    /** Optional prompt headline override (e.g. the rule that forced the ask). */
    title?: string;
}

/**
 * once = run this time only · always = run + persist `patterns` as allows ·
 * never = refuse + persist `patterns` as denies · deny = refuse this time.
 */
export type BashApprovalDecision = "once" | "always" | "never" | "deny";

export interface BashApprovalBridge {
    /**
     * Show the prompt and resolve with the user's decision. Must resolve
     * promptly ("deny") when `signal` aborts, and must always restore the
     * editor UI on exit. Concurrent calls (parallel tool calls) must serialize.
     */
    confirm(req: BashApprovalRequest, opts?: { signal?: AbortSignal }): Promise<BashApprovalDecision>;
}

let bridge: BashApprovalBridge | null = null;

/** CLI (interactive mode only) registers its implementation at startup. */
export function setBashApprovalBridge(b: BashApprovalBridge | null): void {
    bridge = b;
}

export function getBashApprovalBridge(): BashApprovalBridge | null {
    return bridge;
}
