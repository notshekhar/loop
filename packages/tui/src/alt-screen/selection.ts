import type { ScrollView } from "../components/scroll-view";
import { getScrollViewBox, getScrollViewsAt, type LayoutFrame } from "../layout";
import { isImageLine } from "../terminal-image";
import { getOsc8LinkAtColumn, sliceByColumn, stripTerminalSequences, visibleWidth } from "../utils";
import { buttonOf, isMotion, type SgrMouseEvent } from "./mouse-events";
import {
    highlightSelection,
    isBefore,
    lineSelection,
    orderedRange,
    type SelectionPoint,
    type SelectionRange,
    selectionColumns,
    wordSelection,
} from "./selection-geometry";
import type { ViewportHost } from "./viewport-host";

const DOUBLE_CLICK_INTERVAL_MS = 500;
/** How often a drag held past the edge of a scroll view scrolls it by a row. */
const AUTO_SCROLL_INTERVAL_MS = 50;

type SelectionGranularity = "character" | "word" | "line";

interface ClickTarget {
    timestamp: number;
    count: number;
    row: number;
    scrollView?: ScrollView;
    wordStart: number;
    wordEnd: number;
}

export interface SelectionHost extends ViewportHost {
    /** The screen as drawn last frame. */
    previousScreen(): readonly string[];
    copyOnSelect(): boolean;
    copy(text: string): Promise<boolean>;
    /** A primary-button click (press and release on one cell, no drag, not a link). */
    onClick(x: number, y: number): void;
    openUrl?: (url: string) => void;
}

/** The rows of a scroll view's box that are on screen, or undefined if none are. */
function visibleRows(layout: LayoutFrame, scrollView: ScrollView, terminalRows: number) {
    const box = getScrollViewBox(layout, scrollView);
    if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
    const top = Math.max(0, box.rect.y, box.clip.y);
    const bottom = Math.min(terminalRows - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
    return { box, top, bottom };
}

/**
 * Application-owned text selection: click and drag (with auto-scroll past a
 * scroll view's edge), double-click for a word, triple-click for a line,
 * click a link to open it, and copy on release.
 */
export class TextSelection {
    private anchor?: SelectionPoint;
    private focus?: SelectionPoint;
    private granularity: SelectionGranularity = "character";
    private initialRange?: SelectionRange;
    private lastClick?: ClickTarget;
    private dragPointer?: { x: number; y: number };
    private autoScrollDirection: -1 | 0 | 1 = 0;
    private autoScrollTimer?: NodeJS.Timeout;
    private pressActive = false;
    private pressedUrl?: string;
    private dragged = false;

    constructor(private readonly host: SelectionHost) {}

    /** Forget everything: the selection, the press in progress, click history. */
    reset(): void {
        this.cancelPress();
        this.clearRange();
        this.lastClick = undefined;
        this.pressedUrl = undefined;
        this.dragged = false;
    }

    /** Stop a press in progress (and its auto-scroll), keeping the selection. */
    cancelPress(): void {
        this.stopAutoScroll();
        this.pressActive = false;
    }

    /** The terminal lost focus mid-gesture: drop the press, and the selection it was making. */
    onFocusLost(): void {
        const hadPress = this.pressActive;
        const hadSelection = hadPress && this.range() !== undefined;
        this.cancelPress();
        this.pressedUrl = undefined;
        this.dragged = false;
        if (hadPress) {
            this.clearRange();
            if (hadSelection) this.host.requestRender();
        }
        this.lastClick = undefined;
    }

    /** The selection in reading order, or undefined when nothing is selected. */
    range(): SelectionRange | undefined {
        if (!this.anchor || !this.focus) return undefined;
        return orderedRange(this.anchor, this.focus);
    }

    /** The selected text, styles stripped and trailing spaces trimmed per line. */
    text(): string | undefined {
        const selection = this.range();
        if (!selection) return undefined;
        const sourceLines = this.sourceLinesFor(selection.start.scrollView);
        if (!sourceLines) return undefined;
        const lines: string[] = [];
        for (let row = selection.start.row; row <= selection.end.row; row++) {
            const line = sourceLines[row] ?? "";
            const columns = selectionColumns(line, row, selection);
            const slice = sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true);
            lines.push(stripTerminalSequences(slice).trimEnd());
        }
        const text = lines.join("\n");
        return text.length === 0 ? undefined : text;
    }

    handleMouse(event: SgrMouseEvent): void {
        const button = buttonOf(event);
        if (button !== 0 && !(event.release && button === 3)) return;
        const point = this.pointFor(event, this.anchor?.scrollView);
        if (event.release) this.release(event, point);
        else if (isMotion(event)) this.drag(event, point);
        else this.press(event);
    }

    /** Draw the selection in inverse video. */
    apply(screen: string[], layout: LayoutFrame | undefined): string[] {
        const selection = this.range();
        if (!selection) return screen;
        const view = this.screenView(selection, screen.length, layout);
        if (!view) return screen;
        const { range, minRow, maxRow, minColumn, maxColumn } = view;
        return screen.map((line, row) => {
            if (row < minRow || row > maxRow || row < range.start.row || row > range.end.row || isImageLine(line)) {
                return line;
            }
            const columns = selectionColumns(line, row, range, minColumn, maxColumn);
            if (columns.end <= columns.start) return line;
            const lineWidth = visibleWidth(line);
            const before = sliceByColumn(line, 0, columns.start, true);
            const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
            const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
            return `${before}${highlightSelection(selected)}${after}`;
        });
    }

    private clearRange(): void {
        this.anchor = undefined;
        this.focus = undefined;
        this.granularity = "character";
        this.initialRange = undefined;
    }

    /** Where the selection sits on screen, and the box it is clipped to. */
    private screenView(selection: SelectionRange, screenRows: number, layout: LayoutFrame | undefined) {
        const scrollView = selection.start.scrollView;
        if (!scrollView) {
            return {
                range: selection,
                minRow: 0,
                maxRow: screenRows - 1,
                minColumn: 0,
                maxColumn: this.host.terminal.columns,
            };
        }
        const box = layout ? getScrollViewBox(layout, scrollView) : undefined;
        if (!box) return undefined;
        const toScreen = (point: SelectionPoint): SelectionPoint => ({
            ...point,
            row: box.rect.y + point.row - scrollView.scrollTop,
            col: box.rect.x + point.col,
        });
        return {
            range: { start: toScreen(selection.start), end: toScreen(selection.end) },
            minRow: Math.max(0, box.rect.y, box.clip.y),
            maxRow: Math.min(screenRows - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1),
            minColumn: Math.max(0, box.rect.x, box.clip.x),
            maxColumn: Math.min(this.host.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width),
        };
    }

    private sourceLinesFor(scrollView: ScrollView | undefined): readonly string[] | undefined {
        if (!scrollView) return this.host.previousScreen();
        const layout = this.host.layout();
        return layout ? getScrollViewBox(layout, scrollView)?.scrollContentLines : undefined;
    }

    private sourceLine(point: SelectionPoint): string {
        const layout = this.host.layout();
        if (point.scrollView && layout) {
            const lines = getScrollViewBox(layout, point.scrollView)?.scrollContentLines;
            if (lines) return lines[point.row] ?? "";
        }
        return this.host.previousScreen()[point.row] ?? "";
    }

    private release(event: SgrMouseEvent, point: SelectionPoint): void {
        if (!this.pressActive) return;
        this.cancelPress();
        if (!this.anchor) return;
        this.updateFocus(point);
        const onSamePoint =
            !this.dragged &&
            this.anchor.scrollView === point.scrollView &&
            this.anchor.row === point.row &&
            this.anchor.col === point.col;
        const clickedUrl = onSamePoint ? this.pressedUrl : undefined;
        this.pressedUrl = undefined;
        if (clickedUrl && this.host.openUrl) {
            this.anchor = undefined;
            this.focus = undefined;
            try {
                this.host.openUrl(clickedUrl);
            } catch {
                // URL activation is best-effort.
            }
            this.host.requestRender();
            return;
        }
        // A click, not a drag: the selection it made is empty, so this
        // costs the selection nothing and lets the application act on it.
        if (onSamePoint) this.host.onClick(event.x, event.y);
        if (this.host.copyOnSelect()) void this.copy();
        this.host.requestRender();
    }

    private async copy(): Promise<boolean> {
        const text = this.text();
        if (!text) return false;
        return this.host.copy(text);
    }

    private drag(event: SgrMouseEvent, point: SelectionPoint): void {
        if (!this.pressActive || !this.anchor) return;
        this.dragged = true;
        this.lastClick = undefined;
        this.pressedUrl = undefined;
        this.updateFocus(point);
        this.updateAutoScroll(event);
        this.host.requestRender();
    }

    /** A press starts a selection: one click a point, two a word, three a line. */
    private press(event: SgrMouseEvent): void {
        this.stopAutoScroll();
        this.pressActive = true;
        const layout = this.host.layout();
        const scrollView =
            !this.host.hasOverlay() && layout ? getScrollViewsAt(layout, event.x, event.y)[0] : undefined;
        const anchor = this.pointFor(event, scrollView);
        const word = wordSelection(this.sourceLine(anchor), anchor);
        const clickCount = this.clickCount(anchor, word);
        const range =
            clickCount === 2 ? word : clickCount === 3 ? lineSelection(this.sourceLine(anchor), anchor) : undefined;
        this.granularity = range ? (clickCount === 2 ? "word" : "line") : "character";
        this.initialRange = range;
        this.anchor = range?.start ?? anchor;
        this.focus = range?.end ?? anchor;
        this.dragged = false;
        this.pressedUrl = range ? undefined : this.linkAt(event);
        this.host.requestRender();
    }

    private linkAt(event: SgrMouseEvent): string | undefined {
        const { rows, columns } = this.host.terminal;
        const line = this.host.previousScreen()[Math.max(0, Math.min(rows - 1, event.y))] ?? "";
        return getOsc8LinkAtColumn(line, Math.max(0, Math.min(columns - 1, event.x)));
    }

    /** The selection point under the pointer: inside a scroll view's content, or on the bare screen. */
    private pointFor(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
        if (scrollView) {
            const point = this.scrollPoint(scrollView, event.x, event.y);
            if (point) return point;
        }
        return {
            row: Math.max(0, Math.min(this.host.terminal.rows - 1, event.y)),
            col: Math.max(0, Math.min(this.host.terminal.columns - 1, event.x)),
        };
    }

    /** A point in a scroll view's content; a pointer outside the view is clamped to its visible rows. */
    private scrollPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
        const layout = this.host.layout();
        const visible = layout ? visibleRows(layout, scrollView, this.host.terminal.rows) : undefined;
        if (!visible || visible.bottom < visible.top) return undefined;
        const { box } = visible;
        const pointerRow = Math.max(visible.top, Math.min(visible.bottom, y));
        const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
        return {
            row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
            col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
            scrollView,
        };
    }

    /** Move the selection's free end; word and line selections grow by whole words or lines. */
    private updateFocus(point: SelectionPoint): void {
        if (this.granularity === "character" || !this.initialRange) {
            this.focus = point;
            return;
        }
        const line = this.sourceLine(point);
        const range = this.granularity === "word" ? wordSelection(line, point) : lineSelection(line, point);
        if (!range) return;
        const initial = this.initialRange;
        if (isBefore(range.start, initial.start)) {
            this.anchor = initial.end;
            this.focus = range.start;
        } else {
            this.anchor = initial.start;
            this.focus = range.end;
        }
    }

    /** 1, 2 or 3: repeated quick presses on the same word cycle through point, word and line. */
    private clickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
        const now = Date.now();
        const previous = this.lastClick;
        const count =
            word &&
            previous &&
            now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
            previous.row === point.row &&
            previous.scrollView === point.scrollView &&
            previous.wordStart === word.start.col &&
            previous.wordEnd === word.end.col
                ? (previous.count % 3) + 1
                : 1;
        this.lastClick = word
            ? {
                  timestamp: now,
                  count,
                  row: point.row,
                  scrollView: point.scrollView,
                  wordStart: word.start.col,
                  wordEnd: word.end.col,
              }
            : undefined;
        return count;
    }

    /** Keep scrolling while a drag is held at or past the top or bottom of its scroll view. */
    private updateAutoScroll(event: SgrMouseEvent): void {
        const scrollView = this.anchor?.scrollView;
        const layout = this.host.layout();
        const visible = scrollView && layout ? visibleRows(layout, scrollView, this.host.terminal.rows) : undefined;
        if (!visible) {
            this.stopAutoScroll();
            return;
        }
        this.dragPointer = { x: event.x, y: event.y };
        this.autoScrollDirection = event.y <= visible.top ? -1 : event.y >= visible.bottom ? 1 : 0;
        if (this.autoScrollDirection === 0) {
            this.stopAutoScroll();
            return;
        }
        if (this.autoScrollTimer) return;
        this.autoScrollTimer = setInterval(() => this.autoScrollStep(), AUTO_SCROLL_INTERVAL_MS);
        this.autoScrollTimer.unref();
    }

    private autoScrollStep(): void {
        const scrollView = this.anchor?.scrollView;
        const pointer = this.dragPointer;
        const direction = this.autoScrollDirection;
        if (!scrollView || !pointer || direction === 0) {
            this.stopAutoScroll();
            return;
        }
        // Nothing left to scroll that way.
        if (scrollView.scrollBy(direction) === direction) {
            this.stopAutoScroll();
            return;
        }
        const point = this.scrollPoint(scrollView, pointer.x, pointer.y);
        if (point) this.updateFocus(point);
        this.host.requestRender();
    }

    private stopAutoScroll(): void {
        if (this.autoScrollTimer) {
            clearInterval(this.autoScrollTimer);
            this.autoScrollTimer = undefined;
        }
        this.autoScrollDirection = 0;
        this.dragPointer = undefined;
    }
}
