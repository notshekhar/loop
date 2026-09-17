import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { createShellsTool } from "./shells";
import { createSqlTool } from "./sql";
import { createWriteTool } from "./write";

export interface ToolContext {
    cwd: string;
    abortSignal?: AbortSignal;
    shellPath?: string;
    commandPrefix?: string;
    /**
     * Scopes the read-before-edit registry. Concurrent sessions in one
     * process (RPC) must not share read state; absent = one shared slate.
     */
    sessionId?: string;
    /**
     * Force bash into a fail-closed, kernel-enforced read-only sandbox (no
     * writable cwd). Set for read-only agents (e.g. plan) that get bash but no
     * write/edit, so bash physically cannot mutate the filesystem.
     */
    readOnlyFs?: boolean;
}

export function createTools(ctx: ToolContext) {
    return {
        read: createReadTool(ctx),
        write: createWriteTool(ctx),
        edit: createEditTool(ctx),
        bash: createBashTool(ctx),
        ls: createLsTool(ctx),
        grep: createGrepTool(ctx),
        find: createFindTool(ctx),
        // sql is read-only by enforcement (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE), so
        // it lives in the main toolset like any other tool: the default agent
        // gets it automatically, and restricted agents keep it only if their
        // allowlist names it (plan/data-analyst do, via READONLY_TOOLS).
        sql: createSqlTool(ctx),
        // shells is the read/kill half of bash's run_in_background, so it is
        // built here unconditionally and then dropped for the turn when the
        // opt-in backgroundShells setting is off (runTurn / context-report).
        // With the setting on it stays for the whole turn, because a tool the
        // model only discovers after it has already started a shell is a tool
        // it cannot plan around. Cheap when idle — every action on an empty
        // registry is one line of text.
        shells: createShellsTool(ctx),
    };
}

export type ToolSet = ReturnType<typeof createTools>;

/** Stable tool name list — agents reference these for per-agent tool selection. */
export const TOOL_NAMES = ["read", "write", "edit", "bash", "ls", "grep", "find", "sql", "shells"] as const;
export { createMcpResourceTool, MCP_RESOURCE_TOOL_NAME, type McpResourceToolContext } from "./mcp-resource";
export {
    buildMcpToolSearchNote,
    createMcpToolsTool,
    scoreTool,
    MCP_TOOLS_TOOL_NAME,
    type McpToolsToolContext,
} from "./mcp-tools";
export { clearReadRegistry } from "./utils/read-registry";
// Background shells (bash run_in_background): the registry is the surfaces'
// window onto them — the CLI's panel, /shells, and the turn's exit notices.
export {
    formatDuration,
    isShellPanelPresent,
    killAllBashChildren,
    killAllShells,
    killSessionShells,
    killShell,
    listShells,
    onShellChange,
    readShell,
    runningShellCount,
    setShellPanelPresent,
    takeShellNotices,
    MAX_BACKGROUND_SHELLS,
    type ShellInfo,
    type ShellStatus,
} from "./utils/shell-registry";
export { formatShellNotices, SHELLS_TOOL_NAME } from "./shells";
// Process cleanup on the way out. killTrackedDetachedChildren has existed
// since detached spawning did and was never called from anywhere — a bash
// child could outlive the loop that spawned it. Background shells make wiring
// it mandatory, so it is exported here alongside them.
export { getShellConfig, getShellEnv, killTrackedDetachedChildren } from "./utils/shell";
// Registering a shell the USER started (/shells run) — same registry, so the
// agent can read a server its user launched.
export { registerShell } from "./utils/shell-registry";
// Bash denylist guardrail — types + defaults for the /bashdeny management UI.
export {
    DEFAULT_BASH_DENY,
    denyPattern,
    findDeniedCommand,
    formatDenyRefusal,
    isCommandAllowed,
    suggestAllowPatterns,
    type BashDenyEntry,
} from "./utils/command-deny";
// Bash approval prompt (bashApprove setting): the CLI registers its UI bridge
// at startup; without one the setting is inert (print mode / RPC).
export {
    getBashApprovalBridge,
    setBashApprovalBridge,
    type ApprovalKind,
    type BashApprovalBridge,
    type BashApprovalDecision,
    type BashApprovalRequest,
} from "./approval-bridge";
// Permission rules (allow/ask/deny) — engine + types for the settings UI and
// project rule files. Matching semantics documented in the module header.
export {
    DANGEROUS_COMMANDS,
    clearPermissionRulesCache,
    enforcePathPermission,
    evaluateBashRules,
    evaluatePathRules,
    getPermissionRules,
    isDangerousCommand,
    matchBashPattern,
    matchPathPattern,
    parsePermissionsSetting,
    parseRuleString,
    type PermissionAction,
    type PermissionRule,
    type PermissionsSetting,
    type PermissionToolClass,
} from "./utils/permission-rules";
// Resolves the bundled/downloaded `fd` & `rg` binaries — also used by the CLI to
// power @-mention fuzzy file search in the editor's autocomplete.
export { ensureTool, getToolPath } from "./utils/tools-manager";
// ask tool: not part of createTools/TOOL_NAMES — conditionally attached in
// runTurn (like task), gated on the askUser setting + a live UI bridge.
export { askInputSchema, createAskTool, formatAskAnswers, type AskToolContext } from "./ask";
// websearch tool: also conditionally attached in runTurn, gated on the
// webSearch setting (default off). No UI bridge — works in print mode too.
export { createWebsearchTool, type WebsearchToolContext } from "./websearch";
// artifact tool: conditionally attached in runTurn, gated on the `artifacts`
// setting (default off). Publishes a file the agent wrote with the ordinary
// write tool — authoring stays on write/edit, so nothing here special-cases
// paths. No UI bridge; print mode gets it too.
export {
    ARTIFACT_RESULT_SEPARATOR,
    ARTIFACT_TOOL_NAME,
    artifactResultSummary,
    createArtifactTool,
    parseArtifactResult,
    type ArtifactResultPayload,
    type ArtifactToolContext,
} from "./artifact";
// skill tool: conditionally attached in runTurn whenever the turn has visible
// skills (rides the `skills` setting + trust gate — no setting of its own).
// Parent turn only; subagents keep the read-tool fallback.
export { createSkillTool, SKILL_TOOL_NAME, stripSkillFrontmatter, type SkillToolContext } from "./skill";
// plan tool: conditionally attached in runTurn for agents whose tool list
// names it (the plan builtin does). A substantial delivery stops the turn.
export {
    createPlanTool,
    isDeliveredPlan,
    normalizePlanText,
    PLAN_MIN_CHARS,
    PLAN_TOOL_NAME,
    planDeliveredThisStep,
} from "./plan";
// Plan mode: session-level read-only gate (edit/write reject, bash sandboxed
// read-only) + the approval-gated enter_plan_mode / exit_plan_mode pair that
// flips it on and back off without ending the turn.
export { formatPlanModeRefusal, isPlanModeActive, setPlanMode } from "./utils/plan-mode";
export { createEnterPlanModeTool, ENTER_PLAN_MODE_TOOL_NAME, type EnterPlanModeContext } from "./enter-plan-mode";
export {
    createExitPlanModeTool,
    EXIT_PLAN_MODE_TOOL_NAME,
    planHeadline,
    type ExitPlanModeContext,
} from "./exit-plan-mode";
// todo tool: conditionally attached in runTurn (todos setting, default OFF),
// after the task tool so subagents never inherit it. Works in print mode.
export {
    clearSessionTodos,
    createTodoNudger,
    createTodoTool,
    formatTodoList,
    getSessionTodos,
    hasActiveTodos,
    isTodosPayload,
    latestTodos,
    seedSessionTodos,
    TODO_TOOL_NAME,
    TODOS_KIND,
    validateTodos,
    type TodoItem,
    type TodosPayload,
    type TodoStatus,
} from "./todo";
export {
    getAskUserBridge,
    isAskUserAvailable,
    setAskUserBridge,
    type AskAnswer,
    type AskOption,
    type AskQuestion,
    type AskUserBridge,
} from "./ask-bridge";

export {
    createBashTool,
    createEditTool,
    createFindTool,
    createGrepTool,
    createLsTool,
    createReadTool,
    createSqlTool,
    createWriteTool,
};
