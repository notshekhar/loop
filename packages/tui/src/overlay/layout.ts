import type { OverlayAnchor, OverlayLayout, OverlayMargin, OverlayOptions, SizeValue } from "./types";

/** The overlay width used when none is given — a comfortable reading measure. */
const DEFAULT_OVERLAY_WIDTH = 80;

type Margins = Required<OverlayMargin>;

/** Parse "50%" into 0.5; undefined for anything else. */
function parsePercent(value: string): number | undefined {
    const match = value.match(/^(\d+(?:\.\d+)?)%$/);
    return match ? parseFloat(match[1]) / 100 : undefined;
}

/** Parse a SizeValue into absolute value given a reference size */
export function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number") return value;
    const percent = parsePercent(value);
    return percent === undefined ? undefined : Math.floor(referenceSize * percent);
}

/** Margins clamped to non-negative. Resolved per composite so a callable margin tracks what it is anchored to. */
function resolveMargins(margin: OverlayOptions["margin"]): Margins {
    const value = typeof margin === "function" ? margin() : margin;
    const sides = typeof value === "number" ? { top: value, right: value, bottom: value, left: value } : (value ?? {});
    return {
        top: Math.max(0, sides.top ?? 0),
        right: Math.max(0, sides.right ?? 0),
        bottom: Math.max(0, sides.bottom ?? 0),
        left: Math.max(0, sides.left ?? 0),
    };
}

function resolveWidth(opt: OverlayOptions, termWidth: number, availWidth: number): number {
    let width = parseSizeValue(opt.width, termWidth) ?? Math.min(DEFAULT_OVERLAY_WIDTH, availWidth);
    if (opt.minWidth !== undefined) width = Math.max(width, opt.minWidth);
    return Math.max(1, Math.min(width, availWidth));
}

function resolveMaxHeight(opt: OverlayOptions, termHeight: number, availHeight: number): number | undefined {
    const maxHeight = parseSizeValue(opt.maxHeight, termHeight);
    return maxHeight === undefined ? undefined : Math.max(1, Math.min(maxHeight, availHeight));
}

export function resolveAnchorRow(
    anchor: OverlayAnchor,
    height: number,
    availHeight: number,
    marginTop: number,
): number {
    switch (anchor) {
        case "top-left":
        case "top-center":
        case "top-right":
            return marginTop;
        case "bottom-left":
        case "bottom-center":
        case "bottom-right":
            return marginTop + availHeight - height;
        case "left-center":
        case "center":
        case "right-center":
            return marginTop + Math.floor((availHeight - height) / 2);
    }
}

export function resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
    switch (anchor) {
        case "top-left":
        case "left-center":
        case "bottom-left":
            return marginLeft;
        case "top-right":
        case "right-center":
        case "bottom-right":
            return marginLeft + availWidth - width;
        case "top-center":
        case "center":
        case "bottom-center":
            return marginLeft + Math.floor((availWidth - width) / 2);
    }
}

/**
 * Place an overlay along one axis. A percentage spans the free space (0% =
 * start, 100% = end, overlay stays within bounds); an invalid one falls back
 * to centre; no position at all uses the anchor.
 */
function resolveAxis(
    position: SizeValue | undefined,
    fromAnchor: (anchor: OverlayAnchor) => number,
    anchor: OverlayAnchor,
    freeSpace: number,
    marginStart: number,
): number {
    if (position === undefined) return fromAnchor(anchor);
    if (typeof position === "number") return position;
    const percent = parsePercent(position);
    if (percent === undefined) return fromAnchor("center");
    return marginStart + Math.floor(Math.max(0, freeSpace) * percent);
}

/** Resolve overlay size and screen position from its options. */
export function resolveOverlayLayout(
    options: OverlayOptions | undefined,
    overlayHeight: number,
    termWidth: number,
    termHeight: number,
): OverlayLayout {
    const opt = options ?? {};
    const margin = resolveMargins(opt.margin);
    const availWidth = Math.max(1, termWidth - margin.left - margin.right);
    const availHeight = Math.max(1, termHeight - margin.top - margin.bottom);

    const width = resolveWidth(opt, termWidth, availWidth);
    const maxHeight = resolveMaxHeight(opt, termHeight, availHeight);
    const height = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;
    const anchor = opt.anchor ?? "center";

    let row = resolveAxis(
        opt.row,
        (a) => resolveAnchorRow(a, height, availHeight, margin.top),
        anchor,
        availHeight - height,
        margin.top,
    );
    let col = resolveAxis(
        opt.col,
        (a) => resolveAnchorCol(a, width, availWidth, margin.left),
        anchor,
        availWidth - width,
        margin.left,
    );
    row += opt.offsetY ?? 0;
    col += opt.offsetX ?? 0;

    // Clamp to terminal bounds (respecting margins)
    row = Math.max(margin.top, Math.min(row, termHeight - margin.bottom - height));
    col = Math.max(margin.left, Math.min(col, termWidth - margin.right - width));
    return { width, row, col, maxHeight };
}
