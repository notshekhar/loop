import type { FoldSpan } from "../../transcript-folds";
import type { FoldView, OpenFolds } from "../transcript-fold-view";
import type { Foldable } from "./foldables";
import type { EntryRange } from "./render";

/** What the selection needs from the transcript it moves over. */
export interface SelectionHost {
    /** Every selectable entry in transcript order. */
    foldables(): readonly Foldable[];
    /** The fold view as of now — derived fresh on every use. */
    foldView(): FoldView;
    /** Which folds the user opened. */
    readonly openFolds: OpenFolds;
}

/**
 * The entry selection (ctrl+up/down, alt+up/down, clicks) and the folds it
 * opens and closes from the keyboard.
 */
export class TranscriptSelection {
    private selected: number | null = null;
    /** Line ranges per foldable within the last full render (click targets
     * and the scroll anchor). Rebuilt on every render. */
    private lastRanges: EntryRange[] = [];
    /**
     * Set when a user action moved or reflowed the selection, so whoever owns
     * scrolling can bring it back into view — see {@link takeRevealRequest}.
     *
     * A flag rather than a scroll: this component renders the transcript and
     * knows where each entry sits in it, but the window onto that transcript
     * belongs to the frame (the terminal's own scroll, or the pinned layout's
     * ScrollView). It reports; the app moves.
     */
    private revealRequested = false;

    constructor(private readonly host: SelectionHost) {}

    /** Forget the transcript being discarded. */
    reset(): void {
        this.selected = null;
        this.lastRanges = [];
    }

    /** Take the ranges array the next render fills in. */
    setRanges(ranges: EntryRange[]): void {
        this.lastRanges = ranges;
    }

    requestReveal(): void {
        this.revealRequested = true;
    }

    /**
     * Whether a user action asked for the selection to be scrolled back into
     * view, clearing the request.
     *
     * The transcript never scrolls itself. It renders whole — the terminal
     * (or the pinned layout's ScrollView) is the window onto it, the same one
     * the wheel and PgUp already move — so navigating is not a mode with a
     * viewport of its own, it is the same page with one entry marked. What
     * this reports is only WHEN to look: a selection move or a fold, never a
     * passive repaint, so a streaming turn growing the selected entry cannot
     * drag the page down on every delta.
     */
    takeRevealRequest(): boolean {
        const requested = this.revealRequested;
        this.revealRequested = false;
        return requested;
    }

    /** Where the selected entry sits in the last render, in line numbers. */
    selectedRange(): { start: number; end: number } | null {
        if (this.selected === null) return null;
        const r = this.lastRanges.find((x) => x.fIdx === this.selected);
        return r ? { start: r.start, end: r.end } : null;
    }

    selectedEntry(): Foldable | null {
        return this.selected === null ? null : this.host.foldables()[this.selected];
    }

    hasSelection(): boolean {
        return this.selected !== null;
    }

    /** Move the entry selection (ctrl+up/down). Starts at the most recent
     * entry — the one on screen. Returns false when nothing is selectable. */
    moveSelection(delta: -1 | 1): boolean {
        const foldables = this.host.foldables();
        if (foldables.length === 0) return false;
        const view = this.host.foldView();
        const prev = this.selected;
        const from = prev === null ? foldables.length : prev;
        // Entries hidden inside a closed fold are not on screen, so the
        // selection steps over them — onto the fold's header, which is.
        for (let i = from + delta; i >= 0 && i < foldables.length; i += delta) {
            if (view.isHidden(foldables[i])) continue;
            this.selectIndex(i);
            return true;
        }
        // At either end: stay put, but a first press still selects something.
        if (prev === null) return this.selectLast();
        this.revealRequested = true;
        return true;
    }

    /** Jump the selection to the previous/next user turn (alt+up/down). */
    jumpTurn(delta: -1 | 1): boolean {
        const foldables = this.host.foldables();
        if (foldables.length === 0) return false;
        const from = this.selected ?? foldables.length;
        for (let i = from + delta; i >= 0 && i < foldables.length; i += delta) {
            // User prompts never group, so a hit here is always on screen.
            if (foldables[i].kind === "user") {
                this.selectIndex(i);
                return true;
            }
        }
        return false;
    }

    /** Select the most recent entry on screen (scrollback-focus entry point).
     * The newest entry may be hidden inside a closed fold, in which case its
     * header is what gets selected. */
    selectLast(): boolean {
        const foldables = this.host.foldables();
        const view = this.host.foldView();
        for (let i = foldables.length - 1; i >= 0; i--) {
            if (view.isHidden(foldables[i])) continue;
            this.selectIndex(i);
            return true;
        }
        return false;
    }

    /** Select the entry that owns a line of the last render (0-based).
     * Returns false on a miss — the gaps between entries are not clickable. */
    clickAtLocalLine(line: number): boolean {
        const hit = this.lastRanges.find((r) => line >= r.start && line <= r.end);
        if (!hit) return false;
        this.selectIndex(hit.fIdx);
        return true;
    }

    /** Drop the selection (esc). Returns whether there was one to drop. */
    clearSelection(): boolean {
        const entry = this.selectedEntry();
        if (entry === null) return false;
        entry.handle.setSelected(false);
        this.selected = null;
        return true;
    }

    /** The selected entry's plain-text content (y copy). */
    getSelectedText(): string | null {
        return this.selectedEntry()?.getText() ?? null;
    }

    /** Toggle the selected entry only. Returns false when nothing is selected
     * (the caller falls back to the global expand-all). Response text is
     * selectable (navigation, y-copy) but never folds — collapsing the
     * conversation itself reads as data loss. */
    toggleSelected(): boolean {
        const f = this.selectedEntry();
        if (f === null) return false;
        // On a closed fold's header, Enter opens the fold — the same first
        // step as →, so the two keys never disagree about the row in front of
        // you.
        const view = this.host.foldView();
        const span = view.headedBy(f);
        if (span && !span.open) return this.setFoldOpen(view, span, true);
        if (f.kind === "response") return true;
        f.handle.setExpanded(!f.handle.isExpanded());
        this.revealRequested = true; // folding reflows — keep the entry in view
        return true;
    }

    /**
     * Explicit open/close of the selected entry (Left/Right keys).
     *
     * One key walks the hierarchy in both directions, grok-style. → on a
     * closed fold's header opens the fold; → on a call opens the call. ← folds
     * an open call first; ← on a folded entry inside an open fold closes the
     * fold and moves the selection to its header — the row that now stands
     * for everything that just disappeared.
     */
    setSelectedExpanded(expanded: boolean): boolean {
        const f = this.selectedEntry();
        if (f === null) return false;
        const view = this.host.foldView();

        if (expanded) {
            const span = view.headedBy(f);
            if (span && !span.open) return this.setFoldOpen(view, span, true);
        } else if (!f.handle.isExpanded() || f.kind === "response") {
            const span = view.spanContaining(f);
            if (span?.open) {
                this.setFoldOpen(view, span, false);
                this.selectIndex(this.host.foldables().indexOf(view.headerEntry(span) as Foldable));
                return true;
            }
        }

        if (f.kind === "response") return true; // responses never fold
        f.handle.setExpanded(expanded);
        this.revealRequested = true;
        return true;
    }

    private selectIndex(next: number): void {
        const foldables = this.host.foldables();
        if (this.selected !== null) foldables[this.selected].handle.setSelected(false);
        this.selected = next;
        foldables[next].handle.setSelected(true);
        this.revealRequested = true;
    }

    /** Open or close every entry a fold covers (see OpenFolds for why every
     * entry is marked rather than the header alone). */
    private setFoldOpen(view: FoldView, span: FoldSpan, open: boolean): boolean {
        this.host.openFolds.set(view.entriesOf(span), open);
        this.revealRequested = true;
        return true;
    }
}
