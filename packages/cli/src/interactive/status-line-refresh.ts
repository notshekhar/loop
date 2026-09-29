import {
    contextTokensFromUsage,
    estimateContextTokens,
    getModelSync,
    isPlanModeActive,
    type CostTracker,
    type UsageBlock,
} from "@notshekhar/loop-core";
import type { TUI } from "@notshekhar/loop-tui";
import type { StatusLine } from "./components/status-line";
import type { AppState } from "./state";

export interface StatusLineRefresher {
    /** Update cost + context and repaint. */
    refreshStatusLine(usage?: UsageBlock): void;
    /** Update only the context gauge (no cost, no repaint). */
    refreshStatusLineCtx(usage?: UsageBlock): void;
}

export function createStatusLineRefresher(
    statusLine: StatusLine,
    tracker: CostTracker,
    tui: TUI,
    state: AppState,
): StatusLineRefresher {
    function refreshStatusLineCtx(usage?: UsageBlock): void {
        if (usage) state.latestContextTokens = contextTokensFromUsage(usage);
        const info = getModelSync(state.modelId);
        // 0 = nothing has measured the current context yet (a fresh
        // compaction, or a resume straight after one): estimate it until the
        // next reply reports the real size.
        const used =
            state.latestContextTokens > 0
                ? state.latestContextTokens
                : state.session
                  ? estimateContextTokens(state.session)
                  : 0;
        statusLine.setContext(used, info?.contextWindow ?? 0);
    }

    function refreshStatusLine(usage?: UsageBlock): void {
        statusLine.setCost(tracker.format());
        statusLine.setCostData(tracker.sessionBreakdown());
        // Plan mode is keyed to the session id — resyncing here keeps the
        // flag honest across session switches (/resume, /fork, /tree).
        statusLine.setPlanMode(state.session !== null && isPlanModeActive(state.session.id));
        refreshStatusLineCtx(usage);
        tui.requestRender();
    }

    return { refreshStatusLine, refreshStatusLineCtx };
}
