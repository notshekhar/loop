import type { Component } from "../component";
import { compositeTuiLine } from "../render/line-composite";
import { resolveOverlayLayout } from "./layout";
import type { OverlayOptions } from "./types";
import { sliceByColumn, visibleWidth } from "../utils";

/** An overlay rendered at its final size and screen position. */
export interface PlacedOverlay {
    component: Component;
    lines: string[];
    row: number;
    col: number;
    width: number;
}

/** Render one overlay at its resolved width and place it on screen. */
export function placeOverlay(
    component: Component,
    options: OverlayOptions | undefined,
    termWidth: number,
    termHeight: number,
): PlacedOverlay {
    // Width and maxHeight don't depend on the overlay's height, so a first
    // pass with height 0 settles them before the component renders.
    const { width, maxHeight } = resolveOverlayLayout(options, 0, termWidth, termHeight);
    let lines = component.render(width);
    if (maxHeight !== undefined && lines.length > maxHeight) {
        lines = lines.slice(0, maxHeight);
    }
    const { row, col } = resolveOverlayLayout(options, lines.length, termWidth, termHeight);
    return { component, lines, row, col, width };
}

/**
 * Paint placed overlays over the content lines, in order (later = on top).
 * The frame is padded to at least the terminal height so overlay rows are
 * screen-relative.
 */
export function compositeOverlays(
    lines: readonly string[],
    placed: readonly PlacedOverlay[],
    termWidth: number,
    termHeight: number,
): string[] {
    const result = [...lines];
    const minLinesNeeded = placed.reduce((max, p) => Math.max(max, p.row + p.lines.length), result.length);
    // Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
    // inflation that pushed content into scrollback on terminal widen.
    const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);
    while (result.length < workingHeight) {
        result.push("");
    }

    const viewportStart = Math.max(0, workingHeight - termHeight);
    for (const { lines: overlayLines, row, col, width } of placed) {
        for (let i = 0; i < overlayLines.length; i++) {
            const idx = viewportStart + row + i;
            if (idx < 0 || idx >= result.length) continue;
            result[idx] = compositeTuiLine(result[idx], clampToWidth(overlayLines[i], width), col, width, termWidth);
        }
    }
    return result;
}

/** Defensive: components should already respect their width, but a wide line would corrupt the row. */
function clampToWidth(line: string, width: number): string {
    return visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line;
}
