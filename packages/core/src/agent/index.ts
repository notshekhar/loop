/**
 * The agent package's public surface — a pure re-export barrel. The turn loop
 * itself lives in turn.ts; the machinery it shares with the subagent loop in
 * model-call.ts.
 */
export { runTurn, stepMessagesToEntries, type RunTurnOptions } from "./turn";
export {
    buildAgentCallConfig,
    createStepBilling,
    createYieldGate,
    yieldToEventLoop,
    type AgentCallConfig,
    type StepBilling,
} from "./model-call";
export { CostTracker, stampUsageCost, type AddContext } from "./cost";
export { buildSteakGrid, type SteakGrid, type SteakOptions, type SteakStats } from "./steak";
export { runCompact, CompactAbortedError } from "./compact";
export { runRecap, isRecapPayload, RECAP_KIND, type RecapPayload } from "./recap";
export { cancelRecap, scheduleRecap, RECAP_DELAY_MS } from "./recap-schedule";
export { generateCommitMessage, trimDiffForPrompt } from "./commit-message";
export { parseGoalInput, toGoalSchedule, type ParsedGoal } from "./goal-parse";
export {
    GOAL_MAX_ROUNDS,
    GOAL_MAX_VERIFY_RUNS,
    GOAL_STALL_THRESHOLD,
    GOAL_SAME_STEP_FORCE_VERIFY,
    goalModeDir,
    initGoalState,
    loadGoalState,
    saveGoalState,
    clearGoalState,
    writeGoalPlan,
    readGoalPlan,
    firstUncheckedStep,
    detectBail,
    decideNextAction,
    parseGoalVerdict,
    applyVerdict,
    type GoalModeState,
    type GoalModeStatus,
    type GoalPauseReason,
    type GoalNextAction,
    type GoalVerdict,
    type GoalVerdictAction,
} from "./goal-mode";
export {
    GOAL_PLANNER_SYSTEM,
    GOAL_VERIFIER_SYSTEM,
    buildPlannerPrompt,
    buildVerifierPrompt,
    buildGoalRulesDirective,
    buildContinuationDirective,
    formatGoalElapsed,
} from "./goal-prompts";
export { runGoalRole, type GoalRoleOptions, type GoalRoleResult, type GoalRoleName } from "./goal-roles";
export {
    runBranchSummary,
    BranchSummaryAbortedError,
    collectEntriesForBranchSummary,
    BRANCH_SUMMARY_PREAMBLE,
} from "./branch-summary";
export { estimateContextTokens } from "./model-messages";
export {
    buildContextReport,
    type ContextReport,
    type ContextCategory,
    type SkillTokenEstimate,
} from "./context-report";
export {
    THINKING_LEVELS,
    THINKING_LEVEL_DESCRIPTIONS,
    buildProviderOptions,
    reasoningEffort,
    type ThinkingLevel,
} from "./thinking";
export { loadWorkspaceContext, watchWorkspaceContext, listMemoryFiles, type MemoryFileCandidate } from "./context";
export { loadMemoryContext, memoryDir, type MemoryContext } from "./memory";
export { loadProjectSkills, type Skill } from "./skills";
export { generateSessionTitle, cleanTitle } from "./session-title";
export {
    runHooks,
    loadHooksConfig,
    hookBus,
    listHooksWithSources,
    addPiUserHook,
    removePiUserHook,
    HOOK_EVENTS,
    type HookEvent,
    type HookPayload,
    type HooksConfig,
    type HookOutcome,
    type HookSourceEntry,
} from "./hooks";
export {
    DEFAULT_AGENT_NAME,
    DATA_ANALYST_AGENT_NAME,
    PLAN_AGENT_NAME,
    resolveSavedAgent,
    PLAN_BASE_PROMPT,
    ANALYST_BASE_PROMPT,
    listAgents,
    getAgentModel,
    getAgentPrompt,
    getAgentTools,
    agentExists,
    isBuiltinAgent,
    isHiddenAgent,
    hasBuiltinOverride,
    hasDefaultOverride,
    saveAgent,
    deleteAgent,
    isValidAgentName,
    parseAgentFile,
    AGENT_TOOL_NAMES,
    type AgentInfo,
} from "./agents";
export { DEFAULT_BASE_PROMPT } from "./system-prompt";
export { generateHandoff, handoffGitStatus, handoffMessage } from "./handoff";
export { subagentArgSummary, formatSubagentActivity, type SubagentOutput } from "./subagent";
export { extractImagesFromInput, filterAttachmentsByModalities, type ExtractedImages } from "./images";
export { asTurnEmitter, TURN_EVENT_NAMES, type TurnEmitter, type TurnEvents } from "./events";
export {
    canonicalProjectDir,
    hasProjectTrustInputs,
    getTrustDecision,
    isTrusted,
    setTrust,
    trustForSession,
    getTrustOptions,
    type TrustOption,
    type TrustDecision,
} from "./trust";
