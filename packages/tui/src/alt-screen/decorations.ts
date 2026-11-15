import type { ScrollView } from "../components/scroll-view";
import { getScrollbarGeometry, getScrollViewBox, type LayoutFrame } from "../layout";
import { compositeTuiLine } from "../render/line-composite";
import { isImageLine } from "../terminal-image";
import { truncateToWidth, visibleWidth } from "../utils";

/** Where the jump-to-end label was drawn, so a click on it can be recognised. */
export interface ScrollToEndIndicatorRect {
    row: number;
    column: number;
    width: number;
}

/**
 * Draw the clickable jump-to-end label on the last row of a follow-end
 * scroll view that is scrolled away from its end. Returns the new screen and
 * where the label went (undefined when it isn't shown).
 */
export function compositeScrollToEndIndicator(
    screen: string[],
    layout: LayoutFrame,
    scrollView: ScrollView,
    label: (() => string) | undefined,
    width: number,
): { screen: string[]; rect?: ScrollToEndIndicatorRect } {
    if (!label || !scrollView.followEnd || scrollView.isFollowingEnd) return { screen };
    const box = getScrollViewBox(layout, scrollView);
    const clip = box?.clip;
    if (!box || !clip || clip.width <= 0 || clip.height <= 0) return { screen };
    const row = clip.y + clip.height - 1;
    if (row >= screen.length || isImageLine(screen[row] ?? "")) return { screen };
    // Centered on the full clip so the label doesn't jump when the scrollbar hides,
    // then cut short of the scrollbar column so it never covers the thumb.
    const scrollbarColumn = getScrollbarGeometry(box)?.column;
    const fitted = truncateToWidth(label(), clip.width, "");
    const column = clip.x + Math.floor((clip.width - visibleWidth(fitted)) / 2);
    const rightEdge = scrollbarColumn ?? clip.x + clip.width;
    const text = truncateToWidth(fitted, Math.max(0, rightEdge - column), "");
    const textWidth = visibleWidth(text);
    if (textWidth === 0) return { screen };
    const result = [...screen];
    result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
    return { screen: result, rect: { row, column, width: textWidth } };
}

/** Paint flash messages right-aligned at the top of the screen. */
export function compositeFlashes(screen: string[], flashLines: string[], width: number, height: number): string[] {
    const lines = flashLines.slice(-height);
    if (lines.length === 0) return screen;
    const result = [...screen];
    while (result.length < height) result.push("");
    for (let row = 0; row < lines.length; row++) {
        const line = lines[row]!;
        const flashWidth = visibleWidth(line);
        if (flashWidth === 0) continue;
        result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
    }
    return result;
}
