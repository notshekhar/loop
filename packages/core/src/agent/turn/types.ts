import type { CostTracker } from "../cost";
import type { TurnEmitter } from "../events";
import type { ThinkingLevel } from "../thinking";
import type { Session } from "../../sessions";
import type { BtwMeta } from "../../types";
import type { TeamTurnMeta } from "../../teams";

export interface RunTurnOptions {
    session: Session;
    modelId: string;
    userInput: string;
    cwd: string;
    abortSignal?: AbortSignal;
    tracker: CostTracker;
    emitter: TurnEmitter;
    maxSteps?: number;
    thinkingLevel?: ThinkingLevel;
    /** Named agent whose prompt replaces the built-in persona ("default" = built-in). */
    agent?: string;
    /** Post-turn data-recap generation. Defaults to the `recap` setting (off). */
    recap?: boolean;
    /** internal: recursion depth for Stop-hook continuations */
    hookDepth?: number;
    /**
     * The team started this turn (teams/): a member's brief, or mail that
     * woke an idle thread. Saved on the opening user entry so every client
     * draws a team card instead of a user bubble, and billed as "team".
     */
    team?: TeamTurnMeta;
    /** The user's question opening a `/btw` side thread (sessions/btw.ts). */
    btw?: BtwMeta;
}
