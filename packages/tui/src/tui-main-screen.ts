import { BoundedTerminalWriter } from "./main-screen/bounded-writer";
import { findChangedRange, unchangedWindowShift } from "./main-screen/frame-diff";
import {
    collectKittyImageIds,
    deleteChangedKittyImages,
    deleteKittyImages,
    expandChangedRangeForKittyImages,
    kittyImageReservedRows,
} from "./main-screen/kitty-images";
import { dumpIncrementalRender, logRedraw, overwideLineError } from "./main-screen/render-debug";
import { CLEAR_LINE, moveRows, SYNC_BEGIN, SYNC_END } from "./render/ansi";
import { isImageLine } from "./terminal-image";
import { type TUI, TuiBase, type TuiStopOptions } from "./tui";
import { visibleWidth } from "./utils";

function isTermuxSession(): boolean {
    return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
    previousLines: string[];
    previousWidth: number;
    previousHeight: number;
    cursorRow: number;
    hardwareCursorRow: number;
    maxLinesRendered: number;
    previousViewportTop: number;
}

type CursorPos = { row: number; col: number } | null;

/**
 * One frame on its way to the terminal. The viewport fields start as where
 * the last frame left things and move as an incremental render scrolls.
 */
interface Frame {
    lines: string[];
    cursorPos: CursorPos;
    width: number;
    height: number;
    widthChanged: boolean;
    heightChanged: boolean;
    prevViewportTop: number;
    viewportTop: number;
    hardwareCursorRow: number;
}

/** A frame's changed rows, already widened to cover any image they touch. */
interface Change {
    firstChanged: number;
    lastChanged: number;
    /** The frame only grew at the end: write from the old last line with a newline. */
    appendStart: boolean;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
    readonly mode = "regular" as const;
    private previousLines: string[] = [];
    private previousKittyImageIds = new Set<number>();
    private previousWidth = 0;
    private previousHeight = 0;
    private cursorRow = 0;
    private hardwareCursorRow = 0;
    private maxLinesRendered = 0;
    private previousViewportTop = 0;

    captureRenderState(): TuiMainScreenRenderState {
        return {
            previousLines: [...this.previousLines],
            previousWidth: this.previousWidth,
            previousHeight: this.previousHeight,
            cursorRow: this.cursorRow,
            hardwareCursorRow: this.hardwareCursorRow,
            maxLinesRendered: this.maxLinesRendered,
            previousViewportTop: this.previousViewportTop,
        };
    }

    restoreRenderState(state: TuiMainScreenRenderState): void {
        this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
        this.previousKittyImageIds = new Set();
        this.previousWidth = state.previousWidth;
        this.previousHeight = state.previousHeight;
        this.cursorRow = state.cursorRow;
        this.hardwareCursorRow = state.hardwareCursorRow;
        this.maxLinesRendered = state.maxLinesRendered;
        this.previousViewportTop = state.previousViewportTop;
    }

    protected override resetRenderState(): void {
        this.previousLines = [];
        this.previousWidth = -1;
        this.previousHeight = -1;
        this.cursorRow = 0;
        this.hardwareCursorRow = 0;
        this.maxLinesRendered = 0;
        this.previousViewportTop = 0;
    }

    protected override beforeTerminalStop(options: TuiStopOptions): void {
        if (options.preserveScreen || this.previousLines.length === 0) return;
        this.terminal.write(" ");
        const move = moveRows(this.previousLines.length - this.hardwareCursorRow);
        if (move) this.terminal.write(move);
        this.terminal.write("\r\n");
    }

    protected doRender(): void {
        if (this.stopped) return;
        const frame = this.composeFrame();

        const full = this.fullRedrawReason(frame);
        if (full) {
            this.logRedraw(full.reason, frame);
            this.fullRender(frame, full.clear);
            return;
        }

        const change = this.changeSincePreviousFrame(frame);
        if (!change) {
            // No changes - but still need to update hardware cursor position if it moved
            this.positionHardwareCursor(frame.cursorPos, frame.lines.length);
            this.previousViewportTop = frame.prevViewportTop;
            this.previousHeight = frame.height;
            return;
        }
        if (this.isShrinkingPastScreen(frame) && this.repaintVisibleWindow(frame, change.firstChanged)) return;
        if (change.firstChanged >= frame.lines.length) {
            this.renderRemovedLines(frame, change);
        } else if (change.firstChanged < frame.prevViewportTop) {
            this.renderChangeAboveViewport(frame, change);
        } else {
            this.renderChangedLines(frame, change);
        }
    }

    /** Render, composite overlays, find the cursor marker, and note where the viewport was. */
    private composeFrame(): Frame {
        const width = this.terminal.columns;
        const height = this.terminal.rows;
        const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
        const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
        const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
        const prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;

        this.frameId++;
        this.renderingFrame = true;
        let lines: string[];
        try {
            lines = this.render(width);
        } finally {
            this.renderingFrame = false;
        }
        // Before compositing: overlays pad the frame out to the terminal's
        // height, and where the frame really ends is what an overlay anchored
        // to it needs to know.
        this.contentHeight = lines.length;
        if (this.hasOverlayEntries) {
            lines = this.compositeOverlays(lines, width, height);
        }
        // The cursor marker must be found before line resets are applied.
        const cursorPos = this.extractCursorPosition(lines, height);
        return {
            lines: this.applyLineResets(lines),
            cursorPos,
            width,
            height,
            widthChanged,
            heightChanged,
            prevViewportTop,
            viewportTop: prevViewportTop,
            hardwareCursorRow: this.hardwareCursorRow,
        };
    }

    /** Situations a diff cannot handle, and whether the screen must be cleared first. */
    private fullRedrawReason(frame: Frame): { reason: string; clear: boolean } | undefined {
        // A rebuilt transcript was announced by the caller (see resetFrame).
        // Nothing here can distinguish it from a line inserted above the
        // window, and the two want opposite treatment, so it is a signal
        // rather than a detection.
        if (this.frameReset) {
            this.frameReset = false;
            if (this.previousLines.length > 0) return { reason: "frame reset", clear: true };
        }
        // First render - just output everything without clearing (assumes clean screen)
        if (this.previousLines.length === 0 && !frame.widthChanged && !frame.heightChanged) {
            return { reason: "first render", clear: false };
        }
        // Width changes always need a full re-render because wrapping changes.
        if (frame.widthChanged) {
            return { reason: `terminal width changed (${this.previousWidth} -> ${frame.width})`, clear: true };
        }
        // Height changes normally need a full re-render to keep the visible viewport aligned,
        // but Termux changes height when the software keyboard shows or hides.
        // In that environment, a full redraw causes the entire history to replay on every toggle.
        if (frame.heightChanged && !isTermuxSession()) {
            return { reason: `terminal height changed (${this.previousHeight} -> ${frame.height})`, clear: true };
        }
        // Content shrunk below the working area and no overlays - re-render to clear empty rows
        // (overlays need the padding, so only do this when no overlays are active)
        // Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
        if (this.getClearOnShrink() && frame.lines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
            return { reason: `clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`, clear: true };
        }
        return undefined;
    }

    private changeSincePreviousFrame(frame: Frame): Change | undefined {
        const range = findChangedRange(this.previousLines, frame.lines);
        if (!range) return undefined;
        const { firstChanged, lastChanged } = expandChangedRangeForKittyImages(
            this.previousLines,
            frame.lines,
            range.firstChanged,
            range.lastChanged,
        );
        const appendStart =
            frame.lines.length > this.previousLines.length &&
            firstChanged === this.previousLines.length &&
            firstChanged > 0;
        return { firstChanged, lastChanged, appendStart };
    }

    /**
     * LOCAL CHANGE (keep across pi-mono syncs). A frame that shrinks — a
     * menu closing, a tool group collapsing, the editor going back to one
     * line — ends higher than it did, and the rows it gave up have to be
     * dealt with. Repainting the window from the frame in memory deals with
     * them without clearing the screen and the scrollback, which is what
     * the alternative costs.
     *
     * What it must not do is fill those rows from above the fold. The
     * window can only be pulled back down to the frame's last line by
     * printing lines that have already scrolled off, and a line that has
     * scrolled off is committed: printing it again does not move it, it
     * makes a second copy under the first. Every collapse in a turn asks
     * for a few more, which is how a conversation ends up in the scrollback
     * twice. So the repaint stops at the committed floor and the rows below
     * the frame's end are cleared — the prompt sits that many rows higher
     * until the next append fills them, and the history stays true.
     */
    private isShrinkingPastScreen(frame: Frame): boolean {
        return (
            frame.lines.length < this.previousLines.length &&
            frame.lines.length > frame.height &&
            !this.hasOverlayEntries
        );
    }

    /** Clear the screen (optionally the scrollback too) and write the whole frame. */
    private fullRender(frame: Frame, clear: boolean): void {
        const { lines, height } = frame;
        this.fullRedrawCount += 1;
        const output = this.writer();
        output.append(SYNC_BEGIN);
        if (clear) {
            output.append(deleteKittyImages(this.previousKittyImageIds));
            output.append("\x1b[2J\x1b[H\x1b[3J"); // Clear screen, home, then clear scrollback
        }
        for (let i = 0; i < lines.length; i++) {
            if (i > 0) output.append("\r\n");
            const line = lines[i];
            const imageRows = isImageLine(line) ? kittyImageReservedRows(lines, i) : 1;
            if (imageRows > 1 && imageRows <= height) {
                // Reserve the image's rows first, then draw it from its top row.
                output.append("\r\n".repeat(imageRows - 1));
                output.append(moveRows(-(imageRows - 1)) + line + moveRows(imageRows - 1));
                i += imageRows - 1;
                continue;
            }
            output.append(line);
        }
        output.append(SYNC_END);
        output.flush();
        this.cursorRow = Math.max(0, lines.length - 1);
        this.hardwareCursorRow = this.cursorRow;
        // Reset max lines when clearing, otherwise track growth
        this.maxLinesRendered = clear ? lines.length : Math.max(this.maxLinesRendered, lines.length);
        this.previousViewportTop = Math.max(0, Math.max(height, lines.length) - height);
        this.commitFrame(frame);
    }

    /** All changes are in deleted lines: nothing to draw, just clear the rows the frame gave up. */
    private renderRemovedLines(frame: Frame, change: Change): void {
        const { lines, height } = frame;
        if (this.previousLines.length > lines.length) {
            const output = this.writer();
            output.append(SYNC_BEGIN);
            output.append(deleteChangedKittyImages(this.previousLines, change.firstChanged, change.lastChanged));
            // Move to end of new content (clamp to 0 for empty content)
            const targetRow = Math.max(0, lines.length - 1);
            if (targetRow < frame.prevViewportTop) {
                this.redraw(frame, `deleted lines moved viewport up (${targetRow} < ${frame.prevViewportTop})`);
                return;
            }
            output.append(moveRows(this.lineDiff(frame, targetRow)) + "\r");
            const extraLines = this.previousLines.length - lines.length;
            if (extraLines > height) {
                this.redraw(frame, `extraLines > height (${extraLines} > ${height})`);
                return;
            }
            output.append(this.clearRowsBelow(extraLines, lines.length === 0 ? 0 : 1));
            output.append(SYNC_END);
            output.flush();
            this.cursorRow = targetRow;
            this.hardwareCursorRow = targetRow;
        }
        this.commitFrame(frame);
        this.previousViewportTop = frame.prevViewportTop;
    }

    /** Clear `count` rows starting `offset` below the cursor, without scrolling, and come back. */
    private clearRowsBelow(count: number, offset: number): string {
        let out = count > 0 && offset > 0 ? moveRows(offset) : "";
        for (let i = 0; i < count; i++) {
            out += "\r" + CLEAR_LINE;
            if (i < count - 1) out += moveRows(1);
        }
        return out + moveRows(-Math.max(0, count - 1 + offset));
    }

    /**
     * LOCAL CHANGE (keep across pi-mono syncs). Differential rendering can
     * only touch what was actually visible, so a change above the window
     * cannot be patched in place. It does not follow that the screen has to
     * be thrown away. Three cases, and only the last pays the scrollback:
     *
     *  1. The window's content is untouched — something was inserted above
     *     it (a late MCP or hooks line landing under the banner while a
     *     long conversation holds the screen). Every visible row still says
     *     what it said, so the right amount of output is NONE: only the
     *     line bookkeeping moves.
     *  2. The window's content did change — repaint those rows from the
     *     frame in memory.
     *  3. Kitty images in play: they are addressed in rows the plain
     *     repaint does not account for, so those keep the full redraw.
     */
    private renderChangeAboveViewport(frame: Frame, change: Change): void {
        const { lines, height, prevViewportTop } = frame;
        const shift = unchangedWindowShift(this.previousLines, lines, height, prevViewportTop);
        if (shift !== null) {
            this.cursorRow = Math.max(0, lines.length - 1);
            this.hardwareCursorRow = Math.max(
                lines.length - height,
                Math.min(lines.length - 1, frame.hardwareCursorRow + shift),
            );
            this.previousViewportTop = prevViewportTop + shift;
            this.maxLinesRendered = Math.max(this.maxLinesRendered, lines.length);
            this.commitFrame(frame);
            return;
        }
        const hasImages = this.previousKittyImageIds.size > 0 || lines.some((l) => isImageLine(l));
        if (
            lines.length >= height &&
            !this.hasOverlayEntries &&
            !hasImages &&
            this.repaintVisibleWindow(frame, change.firstChanged)
        ) {
            return;
        }
        this.redraw(frame, `firstChanged < viewportTop (${change.firstChanged} < ${prevViewportTop})`);
    }

    /**
     * Repaint the rows the terminal is showing, from the frame in memory.
     *
     * The alternative — clearing the screen and the scrollback and drawing
     * everything again — buys the same correct screen at the price of the
     * user's terminal history, which is never a trade worth making. The lines
     * that belong on screen are already in the frame; painting them where
     * they go is the whole job. Whatever is in the scrollback stays as it was
     * printed: it cannot be rewritten, only destroyed, so it is left alone.
     *
     * Left alone means exactly that, and it is the one rule this repaint has
     * to keep: a row that has scrolled off the top is COMMITTED. It cannot be
     * taken back, so painting the frame from a line above the window does not
     * move that content down — it prints a second copy of it under the copy
     * already in the history. A frame that shrinks by k asks for exactly that,
     * k lines of it, and a turn full of collapsing blocks asks over and over,
     * which is how a conversation ends up in the scrollback twice. So the
     * window starts at the committed floor at the earliest, and the rows the
     * frame gave up are cleared rather than filled from above it.
     *
     * Returns false when the frame cannot be shown from the floor down: the
     * change itself is above it, or the frame no longer reaches it at all. The
     * only way to paint those is to touch committed rows, so the caller falls
     * back to the redraw instead.
     */
    private repaintVisibleWindow(frame: Frame, firstChanged: number): boolean {
        const { lines, height, prevViewportTop } = frame;
        const top = Math.max(prevViewportTop, Math.max(0, lines.length - height));
        const lastRow = lines.length - 1;
        if (lastRow < top) return false;
        // Rows the frame is too short to fill from the floor. While there are
        // none the window is bottom-anchored and every visible row is real
        // content, whatever changed above it. Once there are, anything that
        // changed above the floor has nowhere to be drawn — that one needs the
        // redraw.
        if (top + height > lines.length && firstChanged < top) return false;
        let buffer = SYNC_BEGIN;
        // Up to the first visible row, wherever the cursor happens to be.
        const upFromCursor = frame.hardwareCursorRow - prevViewportTop;
        if (upFromCursor > 0) buffer += moveRows(-upFromCursor);
        buffer += "\r";
        for (let i = 0; i < height; i++) {
            if (i > 0) buffer += "\r\n";
            buffer += CLEAR_LINE + (lines[top + i] ?? "");
        }
        // The paint ends on the window's last row, which is past the frame's
        // last line whenever the frame no longer fills the window. Come back
        // up to it, so the row the renderer thinks it is on is the row it is
        // on.
        const overshoot = top + height - 1 - lastRow;
        if (overshoot > 0) buffer += moveRows(-overshoot);
        buffer += SYNC_END;
        this.terminal.write(buffer);
        this.cursorRow = lastRow;
        this.hardwareCursorRow = lastRow;
        this.previousViewportTop = top;
        this.maxLinesRendered = Math.max(this.maxLinesRendered, lines.length);
        this.commitFrame(frame);
        return true;
    }

    /** The normal path: rewrite only the changed rows, in place. */
    private renderChangedLines(frame: Frame, change: Change): void {
        const { lines, height } = frame;
        // Keep updates wrapped in synchronized output while writing bounded chunks.
        const output = this.writer();
        output.append(SYNC_BEGIN);
        output.append(deleteChangedKittyImages(this.previousLines, change.firstChanged, change.lastChanged));
        const moveTargetRow = change.appendStart ? change.firstChanged - 1 : change.firstChanged;
        output.append(this.scrollToRow(frame, moveTargetRow));
        const lineDiff = this.lineDiff(frame, moveTargetRow);
        output.append(moveRows(lineDiff));
        output.append(change.appendStart ? "\r\n" : "\r"); // Move to column 0

        // Only render changed lines (firstChanged to lastChanged), not all lines to end
        // This reduces flicker when only a single line changes (e.g., spinner animation)
        const renderEnd = Math.min(change.lastChanged, lines.length - 1);
        if (!this.writeRows(frame, output, change.firstChanged, renderEnd)) return;
        const finalCursorRow = this.clearRowsPastEnd(frame, output, renderEnd);
        output.append(SYNC_END);

        dumpIncrementalRender(
            {
                firstChanged: change.firstChanged,
                viewportTop: frame.viewportTop,
                cursorRow: this.cursorRow,
                height,
                lineDiff,
                hardwareCursorRow: frame.hardwareCursorRow,
                renderEnd,
                finalCursorRow,
                cursorPos: frame.cursorPos,
            },
            lines,
            this.previousLines,
            output.length,
        );
        output.flush();

        // cursorRow tracks end of content (for viewport calculation);
        // hardwareCursorRow tracks actual terminal cursor position (for movement).
        this.cursorRow = Math.max(0, lines.length - 1);
        this.hardwareCursorRow = finalCursorRow;
        // Track terminal's working area (grows but doesn't shrink unless cleared)
        this.maxLinesRendered = Math.max(this.maxLinesRendered, lines.length);
        this.previousViewportTop = Math.max(frame.prevViewportTop, finalCursorRow - height + 1);
        this.commitFrame(frame);
    }

    /** If `row` is below the visible window, scroll the terminal down until it is the last visible row. */
    private scrollToRow(frame: Frame, row: number): string {
        const prevViewportBottom = frame.prevViewportTop + frame.height - 1;
        if (row <= prevViewportBottom) return "";
        const currentScreenRow = Math.max(
            0,
            Math.min(frame.height - 1, frame.hardwareCursorRow - frame.prevViewportTop),
        );
        const scroll = row - prevViewportBottom;
        frame.prevViewportTop += scroll;
        frame.viewportTop += scroll;
        frame.hardwareCursorRow = row;
        return moveRows(frame.height - 1 - currentScreenRow) + "\r\n".repeat(scroll);
    }

    /**
     * Write rows [from, to], each cleared first. Returns false when it had to
     * give up — an image that would scroll (a full redraw took over) or a line
     * wider than the terminal (it throws).
     */
    private writeRows(frame: Frame, output: BoundedTerminalWriter, from: number, to: number): boolean {
        const { lines, width, height } = frame;
        for (let i = from; i <= to; i++) {
            if (i > from) output.append("\r\n");
            const line = lines[i];
            const isImage = isImageLine(line);
            const imageRows = isImage ? kittyImageReservedRows(lines, i, to) : 1;
            if (imageRows > 1) {
                const imageStartScreenRow = i - frame.viewportTop;
                if (imageStartScreenRow < 0 || imageStartScreenRow + imageRows > height) {
                    this.redraw(
                        frame,
                        `kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageRows} > ${height})`,
                    );
                    return false;
                }
                // Clear the image's rows first, then draw it from its top row.
                output.append(CLEAR_LINE + `\r\n${CLEAR_LINE}`.repeat(imageRows - 1));
                output.append(moveRows(-(imageRows - 1)) + line + moveRows(imageRows - 1));
                i += imageRows - 1;
                continue;
            }
            output.append(CLEAR_LINE);
            if (!isImage && visibleWidth(line) > width) {
                const error = overwideLineError(this.logDirectory, lines, i, width);
                // Clean up terminal state before throwing
                this.stop();
                throw error;
            }
            output.append(line);
        }
        return true;
    }

    /** If the frame got shorter, clear the rows it gave up and return to its end. Returns the cursor row. */
    private clearRowsPastEnd(frame: Frame, output: BoundedTerminalWriter, renderEnd: number): number {
        const { lines } = frame;
        if (this.previousLines.length <= lines.length) return renderEnd;
        let finalCursorRow = renderEnd;
        // Move to end of new content first if we stopped before it
        if (renderEnd < lines.length - 1) {
            output.append(moveRows(lines.length - 1 - renderEnd));
            finalCursorRow = lines.length - 1;
        }
        const extraLines = this.previousLines.length - lines.length;
        output.append(`\r\n${CLEAR_LINE}`.repeat(extraLines));
        output.append(moveRows(-extraLines));
        return finalCursorRow;
    }

    /** Rows from where the hardware cursor is to `targetRow`, in screen terms. */
    private lineDiff(frame: Frame, targetRow: number): number {
        const currentScreenRow = frame.hardwareCursorRow - frame.prevViewportTop;
        const targetScreenRow = targetRow - frame.viewportTop;
        return targetScreenRow - currentScreenRow;
    }

    private redraw(frame: Frame, reason: string): void {
        this.logRedraw(reason, frame);
        this.fullRender(frame, true);
    }

    private logRedraw(reason: string, frame: Frame): void {
        logRedraw(this.logDirectory, reason, {
            previous: this.previousLines.length,
            next: frame.lines.length,
            height: frame.height,
        });
    }

    private writer(): BoundedTerminalWriter {
        return new BoundedTerminalWriter((data) => this.terminal.write(data));
    }

    /** The frame is on screen: place the hardware cursor and remember the frame for the next diff. */
    private commitFrame(frame: Frame): void {
        this.positionHardwareCursor(frame.cursorPos, frame.lines.length);
        this.previousLines = frame.lines;
        this.previousKittyImageIds = collectKittyImageIds(frame.lines);
        this.previousWidth = frame.width;
        this.previousHeight = frame.height;
    }

    /**
     * Position the hardware cursor for IME candidate window.
     * @param cursorPos The cursor position extracted from rendered output, or null
     * @param totalLines Total number of rendered lines
     */
    private positionHardwareCursor(cursorPos: CursorPos, totalLines: number): void {
        if (!cursorPos || totalLines <= 0) {
            this.terminal.hideCursor();
            return;
        }
        const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
        const targetCol = Math.max(0, cursorPos.col);
        // Move to the row, then to the absolute column (1-indexed)
        this.terminal.write(moveRows(targetRow - this.hardwareCursorRow) + `\x1b[${targetCol + 1}G`);
        this.hardwareCursorRow = targetRow;
        if (this.getShowHardwareCursor()) {
            this.terminal.showCursor();
        } else {
            this.terminal.hideCursor();
        }
    }
}
