/**
 * Who the keyboard belongs to: the prompt, or the transcript.
 *
 * That is the whole of "navigation". Nothing about the frame changes when
 * focus moves — the rows are the same rows, folded the same way, in the same
 * place on the page. What changes is that an entry is marked, the arrows walk
 * entries instead of history, and the hint row says so.
 *
 * There is ONE door in, `ctrl+e`. The pointer does not open it: a click
 * selects an entry only once the transcript already has the keyboard, so
 * clicking around the screen while you are typing can never take the prompt
 * out from under you.
 */
import type { TUI } from "@notshekhar/loop-tui";
import type { ChatHistory } from "./components/chat-history";
import type { StatusLine } from "./components/status-line";
import type { AppState } from "./state";
import { getToolDetail } from "./ui/tool-detail";

export interface ScrollbackFocusDeps {
    tui: TUI;
    history: ChatHistory;
    statusLine: StatusLine;
    /** The window the transcript is shown through — see AppDeps. */
    transcriptViewport: () => { top: number; height: number };
    /** Scroll the selected entry back into view — see AppDeps. */
    revealSelection: () => void;
}

export interface ScrollbackFocus {
    /** Hand the keyboard to the transcript, selecting its last entry. False
     * when there is nothing to select — an empty transcript has nothing to
     * navigate. */
    enter(): boolean;
    /** Hand it back to the prompt, with every fold back as it was. */
    exit(): void;
    /** A click at a screen row (1-based, as terminals report it): select the
     * entry there. Only while the transcript already has the keyboard — false
     * otherwise, and false when the row holds no entry. */
    clickAtScreenRow(row: number): boolean;
    /** The key hint shown while the transcript has the keyboard. */
    hint(): string;
}

/** Carries the current density, since `d` cycles it and a cycle with no
 * visible state is a key nobody trusts. */
const hintText = (): string =>
    `↑/↓ select · shift+←/→ turn · →/← open/fold · Enter toggle · e all · d detail:${getToolDetail()} · wheel/PgUp scroll · y copy · ctrl+e/Esc exit`;

export function createScrollbackFocus(state: AppState, deps: ScrollbackFocusDeps): ScrollbackFocus {
    const { tui, history, statusLine } = deps;

    const focus: ScrollbackFocus = {
        enter(): boolean {
            if (!history.selectLast()) return false;
            state.scrollbackFocus = true;
            statusLine.setHint(hintText());
            deps.revealSelection();
            tui.requestRender();
            return true;
        },

        /**
         * Leaving puts everything back the way it was before you entered: the
         * selection goes, and so does every fold you opened (see
         * ChatHistory.resetFolds). Navigating is a visit, not an edit.
         */
        exit(): void {
            state.scrollbackFocus = false;
            history.clearSelection();
            history.resetFolds();
            statusLine.setHint(null);
            tui.requestRender();
        },

        /**
         * Map a clicked screen row to the transcript's own rendered lines and
         * select the entry there — while navigating, and only then.
         *
         * The transcript is the first thing in the document, so the line under
         * a screen row is that row plus however far the window it is shown
         * through has scrolled — whether that window is the whole screen
         * (flowing layout) or the transcript's own pane (pinned). Component
         * renders are pure, so measuring by re-rendering is safe; clicks are
         * rare.
         */
        clickAtScreenRow(row: number): boolean {
            // Pointing at the transcript is a navigation gesture, not a way
            // into navigation: while the prompt has the keyboard, a click is
            // the terminal's business (place a cursor, start a selection) and
            // must not move the selection or the focus.
            if (!state.scrollbackFocus) return false;
            const { top, height } = deps.transcriptViewport();
            const screenLine = row - 1;
            if (screenLine < 0 || screenLine >= height) return false;
            const local = screenLine + top;
            if (local >= history.render(tui.terminal.columns).length) return false;
            if (!history.clickAtLocalLine(local)) return false;
            deps.revealSelection();
            tui.requestRender();
            return true;
        },

        hint: hintText,
    };
    return focus;
}
