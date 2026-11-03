/**
 * The team budget (`threadTeamsBudgetUsd`): what a whole team may spend before
 * it is stopped. Its own file so the tools (which refuse to restart a team
 * over it) and the stop that enforces it (index.ts) share one reading.
 */
import { getSetting } from "../settings";
import { teamCost } from "./store";

/** The budget in USD, or null when none is set. */
export function teamBudgetUsd(): number | null {
    const budget = getSetting("threadTeamsBudgetUsd");
    return typeof budget === "number" && budget > 0 ? budget : null;
}

export function isTeamOverBudget(teamId: string): boolean {
    const budget = teamBudgetUsd();
    return budget !== null && teamCost(teamId).usd >= budget;
}
