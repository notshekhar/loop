/**
 * Where things are on screen: how much of the transcript is visible, how far
 * the frame ends above the screen's bottom, and the scrolls that bring the
 * prompt, the newest line or a selected entry back into view.
 */
import type { Container } from "@notshekhar/loop-tui";
import { scrollTopFor } from "../transcript-scroll";
import { createScrollbackFocus, type ScrollbackFocus } from "../scrollback-focus";
import type { AppCore } from "./context";
import type { Layout } from "./layout";

export interface Viewport {
    /** The window the transcript is shown through, in transcript lines. */
    transcriptViewport: () => { top: number; height: number };
    rowsBelowFrame: () => number;
    promptOnScreen: () => boolean;
    rowsBelowEditor: () => number;
    revealPrompt: () => void;
    scrollTranscriptToEnd: () => void;
    revealSelection: () => void;
}

export function createViewport(core: AppCore, layout: Layout): Viewport {
    const { tui, state } = core;
    const { transcriptView } = layout;
    const chromeRows = createChromeRowsMeasure(core, layout.chrome);
    const transcriptViewport = (): { top: number; height: number } => ({
        top: tui.viewportTop,
        // Pinned, the transcript has a pane of its own. Flowing, it shares the
        // screen with the chrome below it, and the rows the chrome is using
        // are not rows the transcript can be seen through.
        height: state.pinnedInput ? transcriptView.viewportHeight : Math.max(1, tui.terminal.rows - chromeRows()),
    });

    /**
     * Rows between the bottom of the frame and the bottom of the SCREEN.
     *
     * A frame at least as tall as the terminal ends on the last row and this is
     * zero. A shorter one — a fresh session, a short transcript with pinning
     * off — ends higher, and an overlay aimed at the screen's last row would
     * come adrift from the prompt and float underneath it. Overlays add this to
     * their bottom margin so they land on the frame instead of on the screen.
     *
     * Scrolled back with pinning off, the frame's end — and the prompt on it —
     * is BELOW the screen, and there is no row to anchor to: the overlays that
     * sit on the prompt hide with it (see promptOnScreen) instead of clamping
     * to the last row, which left a menu floating over the transcript with no
     * prompt under it.
     */
    const rowsBelowFrame = (): number => Math.max(0, tui.rowsBelowContent);
    const promptOnScreen = (): boolean => tui.rowsBelowContent >= 0;
    return {
        transcriptViewport,
        rowsBelowFrame,
        promptOnScreen,
        rowsBelowEditor: () => rowsBelowEditor(core, layout.chrome, layout.editorContainer),
        revealPrompt: () => revealPrompt(core),
        scrollTranscriptToEnd: () => scrollTranscriptToEnd(core, layout),
        revealSelection: () => revealSelection(core, layout, transcriptViewport),
    };
}

/**
 * How many rows the chrome under the transcript is taking this frame: the
 * loader slot, the todo and shells panels, queued messages, the editor,
 * the status line, the trailing spacer.
 *
 * Measured rather than assumed, because all of it moves — the editor grows
 * a row per line of draft, the todo panel appears mid-turn — and it is
 * what says how much of the transcript is actually on screen. Re-rendering
 * to measure is safe: component renders are pure (the spinner advances on
 * its own interval, not on render), the same property click-to-select
 * relies on, and the transcript itself is not re-rendered here.
 *
 * Do not "optimize" this into a cached height — a height cached ACROSS
 * frames is stale in exactly the case that matters, the frame where the
 * editor grows a line. Memoizing WITHIN a single frame is a different
 * thing, and safe: the answer cannot change while one frame is being
 * composed. Worth doing because the measurement is only ~1µs on an empty
 * draft — the editor has no render cache of its own and re-lays out the
 * whole draft on every call (measured 0.05ms at 400 chars, 0.31ms at 4k,
 * 1.2ms at 20k) — and a pinned frame asks twice, once here and once when
 * the chrome is really rendered. The memo is dropped the moment the render
 * pass ends, so anything asking BETWEEN frames still measures the chrome
 * as it is right then.
 */
function createChromeRowsMeasure(core: AppCore, chrome: Container): () => number {
    const { tui } = core;
    let reserve: { frame: number; rows: number } | null = null;
    return (): number => {
        const rendering = tui.isRendering();
        if (rendering && reserve?.frame === tui.renderFrameId) return reserve.rows;
        const rows = chrome.render(tui.terminal.columns).length;
        reserve = rendering ? { frame: tui.renderFrameId, rows } : null;
        return rows;
    };
}

/** Rows of the frame that sit BELOW the editor: the status line, the spacer. */
function rowsBelowEditor(core: AppCore, chrome: Container, editorContainer: Container): number {
    const width = core.tui.terminal.columns;
    let rows = 0;
    let seenEditor = false;
    for (const child of chrome.children) {
        if ((child as unknown) === (editorContainer as unknown)) {
            seenEditor = true;
            continue;
        }
        if (seenEditor) rows += child.render(width).length;
    }
    return rows;
}

/**
 * Bring the selected entry into view after a navigation action.
 *
 * The transcript is one long document and the frame is a window onto it,
 * so this is ordinary scrolling — the same window the wheel and PgUp move.
 * The entry's line range comes from a fresh render (component renders are
 * pure, which is what the click mapper relies on too), and an entry taller
 * than the window pins to its TOP: trying to fit both ends makes the page
 * ping-pong between them on every keystroke.
 */
function revealSelection(
    core: AppCore,
    layout: Layout,
    transcriptViewport: () => { top: number; height: number },
): void {
    const { tui, history, state } = core;
    if (!history.takeRevealRequest()) return;
    history.render(tui.terminal.columns);
    const range = history.selectedRange();
    if (!range) return;
    const view = transcriptViewport();
    const next = scrollTopFor(range, view);
    if (next === view.top) return;
    if (state.pinnedInput) layout.transcriptView.scrollTo(next);
    else tui.scrollBy(next - view.top);
}

export function attachScrollbackFocus(core: AppCore, viewport: Viewport): ScrollbackFocus {
    const { tui, history, statusLine, state } = core;
    const scrollbackFocus = createScrollbackFocus(state, {
        tui,
        history,
        statusLine,
        transcriptViewport: viewport.transcriptViewport,
        revealSelection: viewport.revealSelection,
    });
    // A click selects the transcript entry under it while navigating. The
    // viewport recognises the gesture (it has to, to tell a click from a
    // drag-selection) and hands it over rather than consuming it, so text
    // selection is untouched. It reports 0-based cells; the focus service
    // speaks screen rows the way terminals do.
    tui.onClick = (_x, y) => {
        scrollbackFocus.clickAtScreenRow(y + 1);
    };
    return scrollbackFocus;
}

/**
 * Bring the prompt back into view — a shell's "scroll on keystroke". Input
 * to the prompt, or to a menu drawn on it, is meaningless while it is
 * scrolled off; and a prompt the AGENT opens (an approval, a question) has
 * to be seen. Pinned, the prompt never leaves, and the transcript's scroll
 * position is the reader's to keep.
 */
function revealPrompt(core: AppCore): void {
    const { tui, state } = core;
    if (!state.pinnedInput && !tui.isFollowingOutput) tui.scrollToBottom();
}

/**
 * Jump the transcript to the newest line. Submitting is not the same as
 * typing: revealPrompt deliberately leaves a pinned reader's scroll
 * position alone, because a keystroke is no reason to yank the page — but
 * sending a message is an explicit "show me what happens next", and a
 * pinned transcript that stayed where it was looked like the message had
 * gone nowhere.
 *
 * Pinned, the transcript is its own ScrollView, so tui.scrollToBottom (the
 * terminal's own scrollback) is the wrong lever. Scrolling the view to its
 * end also re-arms follow-end, so the reply streams in without the reader
 * having to chase it.
 */
function scrollTranscriptToEnd(core: AppCore, layout: Layout): void {
    const { tui, state } = core;
    if (state.pinnedInput) layout.transcriptView.scrollTo(Number.MAX_SAFE_INTEGER);
    else if (!tui.isFollowingOutput) tui.scrollToBottom();
}
