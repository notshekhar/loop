import type { ProviderId, Session, ThinkingLevel } from "@notshekhar/loop-core";

/**
 * Mutable runtime state for the interactive app. Handlers in
 * command-handlers / input-handler / turn-runner read and mutate fields here
 * so app.ts doesn't have to thread dozens of `let` bindings through closures.
 */
export interface AppState {
    cwd: string;
    modelId: string;
    provider: ProviderId;
    thinkingLevel: ThinkingLevel;
    /** Active agent name ("default" = built-in system prompt). */
    agent: string;
    /** One-shot agent for the next turn only (/<agent> <message>); cleared at turn start. */
    oneShotAgent: string | null;
    /** Last custom agent selected via /agents — stays in the Tab cycle alongside built-ins. */
    cycleCustomAgent: string | null;
    session: Session | null;
    latestContextTokens: number;
    busy: boolean;
    /** Scrollback focus mode: arrow keys navigate transcript entries. */
    scrollbackFocus: boolean;
    /** The `pinnedInput` setting, live: the prompt is held on the last rows
     * and the transcript scrolls in its own window above it. */
    pinnedInput: boolean;
    abort: AbortController;
    pendingInjection: string | null;
    /** When a quit key was last pressed — the second press within a second quits. */
    lastQuitPressAt: number;
    /** Resolves when trust prompt + SessionStart hooks settle; the first turn
     * awaits it so hook-injected context isn't lost to a fast first prompt. */
    startupHooksDone: Promise<void> | null;
    /** Plan delivered by the plan tool this turn; the turn runner offers
     * implement/talk after the turn ends, then clears it. */
    pendingPlan: string | null;
    /** The session plan-mode gate was armed by Shift+Tab landing on the plan
     * agent — cycling away then disarms it. Gates armed via /plan or
     * enter_plan_mode are NOT tied to the agent cycle and stay put. */
    planModeViaCycle: boolean;
    /** /timer deadline (ms epoch). In-memory only — dies with the process. */
    timerEndsAt: number | null;
    /** Original /timer input ("1h30m"), shown in the time's-up prompt. */
    timerLabel: string;
}
