import type { ScrollView } from "../components/scroll-view";
import { getScrollbarGeometry, getScrollViewBox, type LayoutFrame } from "../layout";
import type { OverlayHandle, OverlayOptions } from "../overlay/types";
import type { Component } from "../component";
import { isImageLine } from "../terminal-image";
import { extractAnsiCode, sliceByColumn, visibleWidth } from "../utils";
import { isPrimaryPress, type SgrMouseEvent } from "./mouse-events";
import { AltScreenSearchComponent } from "./search-bar";
import { type AltScreenSearchMatch, AltScreenSearchIndex, getAltScreenSearchMatchKey } from "./search-index";
import type { ViewportHost } from "./viewport-host";

type SearchSelectionMode = "query" | "retain" | "next" | "previous";

interface ActiveSearch {
    component: AltScreenSearchComponent;
    index: AltScreenSearchIndex;
    overlay?: OverlayHandle;
    query: string;
    matches: AltScreenSearchMatch[];
    selectedIndex: number;
    selectedKey?: string;
    anchorRow: number;
    selectionMode: SearchSelectionMode;
}

interface SearchHighlightRange {
    startCol: number;
    endCol: number;
    current: boolean;
}

export interface SearchStyles {
    match: (text: string) => string;
    currentMatch: (text: string) => string;
    navigationButton: (text: string, hovered: boolean) => string;
}

export interface SearchHost extends ViewportHost {
    showOverlay(component: Component, options: OverlayOptions): OverlayHandle;
}

const SEARCH_BAR_OVERLAY: OverlayOptions = { anchor: "top-right", width: "40%", minWidth: 32, margin: 1 };

/** Index of the first match whose last row is at or after `row` (matches are in row order). */
function firstMatchEndingAtOrAfter(matches: readonly AltScreenSearchMatch[], row: number): number {
    let low = 0;
    let high = matches.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const match = matches[middle]!;
        if ((match.segments[match.segments.length - 1]?.row ?? -1) < row) low = middle + 1;
        else high = middle;
    }
    return low;
}

/** Index of the first match starting at or after `row`, wrapping to 0. */
function firstMatchStartingAtOrAfter(matches: readonly AltScreenSearchMatch[], row: number): number {
    let low = 0;
    let high = matches.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if ((matches[middle]!.segments[0]?.row ?? 0) < row) low = middle + 1;
        else high = middle;
    }
    return low < matches.length ? low : 0;
}

/**
 * Which match is current after a search: the first one from the anchor for a
 * new query, the next or previous one when stepping, otherwise the same one.
 * `exactIndex` is where the previously selected match is now, or -1.
 */
function pickSelectedIndex(search: ActiveSearch, matches: readonly AltScreenSearchMatch[], exactIndex: number): number {
    if (matches.length === 0) return -1;
    const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
    switch (search.selectionMode) {
        case "query":
            return firstMatchStartingAtOrAfter(matches, search.anchorRow);
        case "next":
            return baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
        case "previous":
            return baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
        case "retain":
            return exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
    }
}

/** Search the transcript: the search bar overlay, finding and stepping through matches, and highlighting them. */
export class TranscriptSearch {
    private active?: ActiveSearch;

    constructor(
        private readonly host: SearchHost,
        private readonly styles: SearchStyles,
    ) {}

    /** True while the search bar has keyboard focus. */
    get isFocused(): boolean {
        return this.active?.overlay?.isFocused() === true;
    }

    toggle(): void {
        if (this.active) {
            this.close();
            return;
        }
        const component = new AltScreenSearchComponent(
            (query) => this.updateQuery(query),
            this.styles.navigationButton,
        );
        const search: ActiveSearch = {
            component,
            index: new AltScreenSearchIndex(),
            query: "",
            matches: [],
            selectedIndex: -1,
            anchorRow: this.host.primaryScrollView().scrollTop,
            selectionMode: "query",
        };
        this.active = search;
        search.overlay = this.host.showOverlay(component, SEARCH_BAR_OVERLAY);
    }

    close(): void {
        const search = this.active;
        if (!search) return;
        this.active = undefined;
        search.overlay?.hide();
        this.host.requestRender();
    }

    navigate(direction: -1 | 1): void {
        const search = this.active;
        if (!search?.query) return;
        search.selectionMode = direction < 0 ? "previous" : "next";
        this.host.requestRender();
    }

    /** The pointer left the terminal: drop the hover on the search bar's buttons. */
    clearHover(): void {
        if (this.active?.component.setHoveredNavigationDirection(undefined)) this.host.requestRender();
    }

    /** Hover and click the search bar's previous/next buttons. True when a click stepped the search. */
    handleMouse(event: SgrMouseEvent): boolean {
        const search = this.active;
        if (!search) return false;
        const direction = this.navigationDirectionAt(search, event.x, event.y);
        if (search.component.setHoveredNavigationDirection(direction)) this.host.requestRender();
        if (direction === undefined || !isPrimaryPress(event)) return false;
        this.navigate(direction);
        return true;
    }

    /**
     * Re-run the search against this frame's transcript and pick the current
     * match. True when that scrolled the view, so the frame must be laid out again.
     */
    refresh(layout: LayoutFrame): boolean {
        const search = this.active;
        if (!search) return false;
        const scrollView = this.host.primaryScrollView(layout);
        const box = getScrollViewBox(layout, scrollView);
        const lines = box?.scrollContentLines;
        if (!lines || !search.query.trim()) {
            this.clearResults(search);
            return false;
        }

        const shouldReveal = search.selectionMode !== "retain";
        const result = search.index.search(lines, search.query);
        search.matches = result.matches;
        if (!result.changed && search.selectionMode === "retain") return false;

        const exactIndex = result.changed
            ? search.selectedKey
                ? result.matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey)
                : -1
            : search.selectedIndex;
        const selectedIndex = pickSelectedIndex(search, result.matches, exactIndex);
        search.selectedIndex = selectedIndex;
        search.selectedKey =
            selectedIndex >= 0 ? getAltScreenSearchMatchKey(result.matches[selectedIndex]!) : undefined;
        search.selectionMode = "retain";
        search.component.setResult(selectedIndex, result.matches.length);
        return shouldReveal && box !== undefined && this.reveal(result.matches[selectedIndex], scrollView);
    }

    /** Highlight the matches visible in the transcript box. */
    highlight(screen: string[], layout: LayoutFrame): string[] {
        const search = this.active;
        if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
        const scrollView = this.host.primaryScrollView(layout);
        const rangesByRow = this.visibleRanges(search, screen.length, layout, scrollView);
        if (!rangesByRow) return screen;
        const result = [...screen];
        for (const [row, ranges] of rangesByRow) {
            const line = result[row] ?? "";
            if (!isImageLine(line)) result[row] = this.highlightRanges(line, ranges);
        }
        return result;
    }

    private updateQuery(query: string): void {
        const search = this.active;
        if (!search || query === search.query) return;
        const selected = search.matches[search.selectedIndex];
        search.anchorRow = selected?.segments[0]?.row ?? this.host.primaryScrollView().scrollTop;
        search.query = query;
        search.selectionMode = "query";
        search.component.setResult(-1, 0);
        this.host.requestRender();
    }

    private navigationDirectionAt(search: ActiveSearch, x: number, y: number): -1 | 1 | undefined {
        const bounds = search.overlay?.getBounds();
        if (!bounds) return undefined;
        if (x < bounds.col || x >= bounds.col + bounds.width || y < bounds.row || y >= bounds.row + bounds.height) {
            return undefined;
        }
        return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
    }

    private clearResults(search: ActiveSearch): void {
        search.matches = [];
        search.selectedIndex = -1;
        search.selectedKey = undefined;
        search.selectionMode = "retain";
        search.component.setResult(-1, 0);
    }

    /** Scroll a match into view (a third of the way down) if it isn't. True when the view moved. */
    private reveal(match: AltScreenSearchMatch | undefined, scrollView: ScrollView): boolean {
        const firstSegment = match?.segments[0];
        const lastSegment = match?.segments[match.segments.length - 1];
        if (!firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
        const before = scrollView.scrollTop;
        const visibleBottom = before + scrollView.viewportHeight - 1;
        let target = before;
        if (firstSegment.row < before || lastSegment.row > visibleBottom) {
            target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
        }
        scrollView.scrollTo(target, { disableFollow: true });
        return scrollView.scrollTop !== before;
    }

    /** Screen-space column ranges of every match segment inside the visible box, by row. */
    private visibleRanges(
        search: ActiveSearch,
        screenRows: number,
        layout: LayoutFrame,
        scrollView: ScrollView,
    ): Map<number, SearchHighlightRange[]> | undefined {
        const box = getScrollViewBox(layout, scrollView);
        if (!box) return undefined;
        const scrollbarColumn = getScrollbarGeometry(box)?.column;
        const minRow = Math.max(0, box.rect.y, box.clip.y);
        const maxRow = Math.min(screenRows, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
        const minColumn = Math.max(0, box.rect.x, box.clip.x);
        const maxColumn = Math.min(
            this.host.terminal.columns,
            box.rect.x + box.rect.width,
            box.clip.x + box.clip.width,
            scrollbarColumn ?? Number.POSITIVE_INFINITY,
        );
        const minContentRow = scrollView.scrollTop + minRow - box.rect.y;
        const maxContentRow = scrollView.scrollTop + maxRow - box.rect.y - 1;
        const rangesByRow = new Map<number, SearchHighlightRange[]>();
        for (let i = firstMatchEndingAtOrAfter(search.matches, minContentRow); i < search.matches.length; i++) {
            const match = search.matches[i]!;
            if ((match.segments[0]?.row ?? 0) > maxContentRow) break;
            for (const segment of match.segments) {
                const row = box.rect.y + segment.row - scrollView.scrollTop;
                if (row < minRow || row >= maxRow) continue;
                const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
                const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
                if (endCol <= startCol) continue;
                const ranges = rangesByRow.get(row) ?? [];
                ranges.push({ startCol, endCol, current: i === search.selectedIndex });
                rangesByRow.set(row, ranges);
            }
        }
        return rangesByRow;
    }

    /** Style each range of a line, right to left so earlier columns stay valid. */
    private highlightRanges(line: string, ranges: SearchHighlightRange[]): string {
        let result = line;
        const lineWidth = visibleWidth(line);
        for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
            const startCol = Math.min(range.startCol, lineWidth);
            const endCol = Math.min(range.endCol, lineWidth);
            if (endCol <= startCol) continue;
            const before = sliceByColumn(result, 0, startCol, true);
            const highlighted = sliceByColumn(result, startCol, endCol - startCol, true);
            const after = sliceByColumn(result, endCol, Math.max(0, lineWidth - endCol), true);
            const style = range.current ? this.styles.currentMatch : this.styles.match;
            result = `${before}${styleTextOnly(highlighted, style)}${after}`;
        }
        return result;
    }
}

/** Apply `style` to the plain text runs of `text`, leaving its escape sequences between them untouched. */
function styleTextOnly(text: string, style: (text: string) => string): string {
    let result = "";
    let plainStart = 0;
    let index = 0;
    while (index < text.length) {
        const ansi = extractAnsiCode(text, index);
        if (!ansi) {
            index += 1;
            continue;
        }
        if (index > plainStart) result += style(text.slice(plainStart, index));
        result += ansi.code;
        index += ansi.length;
        plainStart = index;
    }
    if (plainStart < text.length) result += style(text.slice(plainStart));
    return result;
}
