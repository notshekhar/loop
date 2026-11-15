import type { ScrollView } from "./components/scroll-view";
import { allocateStackSizes, visibleStackEntries } from "./components/stack";
import { getLayoutNode, type ScrollLayoutNode, type StackLayoutNode } from "./layout-node";
import { cropKittyImageLine, getKittyImageMetadata, isImageLine } from "./terminal-image";
import { type Component, CURSOR_MARKER, compositeTuiLine } from "./tui";
import { extractAnsiCode, getGraphemeCellRange, sliceByColumn, visibleWidth } from "./utils";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

export interface LayoutRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface LayoutBox {
    component: Component;
    rect: LayoutRect;
    clip: LayoutRect;
    children: LayoutBox[];
    parent?: LayoutBox;
    lines?: readonly string[];
    lineOffset?: number;
    scrollView?: ScrollView;
    scrollContentLines?: readonly string[];
    layer: number;
}

export interface LayoutFrame {
    root: LayoutBox;
    width: number;
    height: number;
    lines: string[];
    primaryScrollView?: ScrollView;
}

export interface ScrollbarGeometry {
    column: number;
    trackTop: number;
    trackHeight: number;
    thumbTop: number;
    thumbHeight: number;
    maxScrollTop: number;
}

interface LayoutContext {
    viewport: { width: number; height: number };
    renderCache: Map<Component, Map<number, string[]>>;
    requestRender: () => void;
    primaryScrollView: ScrollView | undefined;
}

function intersect(a: LayoutRect, b: LayoutRect): LayoutRect {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function renderCached(context: LayoutContext, component: Component, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    let widths = context.renderCache.get(component);
    if (!widths) {
        widths = new Map<number, string[]>();
        context.renderCache.set(component, widths);
    }
    let lines = widths.get(safeWidth);
    if (!lines) {
        lines = component.render(safeWidth);
        widths.set(safeWidth, lines);
    }
    return lines;
}

function measureHeight(context: LayoutContext, component: Component, width: number): number {
    return renderCached(context, component, width).length;
}

function measureWidth(context: LayoutContext, component: Component, width: number): number {
    return renderCached(context, component, width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function withParent(box: LayoutBox, parent: LayoutBox): LayoutBox {
    box.parent = parent;
    return box;
}

function translateBox(box: LayoutBox, deltaY: number): void {
    box.rect.y += deltaY;
    for (const child of box.children) translateBox(child, deltaY);
}

function updateClips(box: LayoutBox, parentClip: LayoutRect): void {
    box.clip = intersect(parentClip, box.rect);
    for (const child of box.children) updateClips(child, box.clip);
}

/** Where a component is being placed. `height` undefined = as tall as it wants. */
interface Slot {
    x: number;
    y: number;
    width: number;
    height: number | undefined;
    clip: LayoutRect;
}

function layoutComponent(context: LayoutContext, component: Component, slot: Slot): LayoutBox {
    const node = getLayoutNode(component);
    if (!node) return layoutLeaf(context, component, slot);
    if (node.type === "scroll") return layoutScroll(context, component, node, slot);
    if (node.type === "vstack") return layoutVStack(context, component, node, slot);
    return layoutHStack(context, component, node, slot);
}

const safeWidthOf = (slot: Slot) => Math.max(1, Math.floor(slot.width));

function emptyBox(component: Component, rect: LayoutRect, clip: LayoutRect): LayoutBox {
    return { component, rect, clip: intersect(clip, rect), children: [], layer: 0 };
}

/**
 * A plain component: its rendered lines, cut to the slot. When they don't
 * fit, the window scrolls just far enough to keep the cursor in view.
 */
function layoutLeaf(context: LayoutContext, component: Component, slot: Slot): LayoutBox {
    const width = safeWidthOf(slot);
    const lines = renderCached(context, component, width);
    const allocatedHeight = slot.height === undefined ? lines.length : Math.max(0, Math.floor(slot.height));
    let lineOffset = 0;
    if (lines.length > allocatedHeight && allocatedHeight > 0) {
        const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
        if (cursorLine >= allocatedHeight) lineOffset = cursorLine - allocatedHeight + 1;
    }
    const rect = { x: slot.x, y: slot.y, width, height: allocatedHeight };
    return { ...emptyBox(component, rect, slot.clip), lines, lineOffset };
}

/** The content laid out at full height, then shifted by the scroll offset and clipped to the viewport. */
function layoutScroll(context: LayoutContext, component: Component, node: ScrollLayoutNode, slot: Slot): LayoutBox {
    const width = safeWidthOf(slot);
    const previousScrollTop = node.state.scrollTop;
    const contentWidth = node.state.getContentWidth(width);
    const childBox = layoutComponent(context, node.component, {
        x: slot.x,
        y: slot.y - previousScrollTop,
        width: contentWidth,
        height: undefined,
        clip: slot.clip,
    });
    const contentHeight = childBox.rect.height;
    const viewportHeight = slot.height === undefined ? contentHeight : Math.max(0, Math.floor(slot.height));
    node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
    translateBox(childBox, previousScrollTop - node.state.scrollTop);
    const scrollView = node.state as ScrollView;
    if (node.state.primary || !context.primaryScrollView) context.primaryScrollView = scrollView;
    const box: LayoutBox = {
        ...emptyBox(component, { x: slot.x, y: slot.y, width, height: viewportHeight }, slot.clip),
        children: [childBox],
        scrollView,
        scrollContentLines: renderCached(context, node.component, contentWidth),
    };
    childBox.parent = box;
    updateClips(childBox, box.clip);
    return box;
}

function layoutVStack(context: LayoutContext, component: Component, node: StackLayoutNode, slot: Slot): LayoutBox {
    const width = safeWidthOf(slot);
    const entries = visibleStackEntries(node.entries, context.viewport);
    const intrinsicHeights = entries.map((entry) =>
        typeof entry.basis === "number" ? entry.basis : measureHeight(context, entry.component, width),
    );
    const sizes = allocateStackSizes(entries, intrinsicHeights, slot.height, node.gap);
    const naturalHeight = sizes.reduce((sum, size) => sum + size, 0) + gapTotal(entries.length, node.gap);
    const allocatedHeight = slot.height === undefined ? naturalHeight : Math.max(0, Math.floor(slot.height));
    const box = emptyBox(component, { x: slot.x, y: slot.y, width, height: allocatedHeight }, slot.clip);
    let childY = slot.y;
    entries.forEach((entry, index) => {
        const child = { x: slot.x, y: childY, width, height: sizes[index]!, clip: box.clip };
        box.children.push(withParent(layoutComponent(context, entry.component, child), box));
        childY += sizes[index]! + node.gap;
    });
    return box;
}

const gapTotal = (count: number, gap: number) => Math.max(0, count - 1) * gap;

function layoutHStack(context: LayoutContext, component: Component, node: StackLayoutNode, slot: Slot): LayoutBox {
    const width = safeWidthOf(slot);
    const entries = visibleStackEntries(node.entries, context.viewport);
    const intrinsicWidths = entries.map((entry) =>
        typeof entry.basis === "number" ? entry.basis : measureWidth(context, entry.component, width),
    );
    const widths = allocateStackSizes(entries, intrinsicWidths, width, node.gap);
    const intrinsicHeights = entries.map((entry, index) =>
        measureHeight(context, entry.component, Math.max(1, widths[index]!)),
    );
    const allocatedHeight =
        slot.height === undefined
            ? intrinsicHeights.reduce((max, childHeight) => Math.max(max, childHeight), 0)
            : Math.max(0, slot.height);
    const box = emptyBox(component, { x: slot.x, y: slot.y, width, height: allocatedHeight }, slot.clip);
    let childX = slot.x;
    entries.forEach((entry, index) => {
        const childHeight =
            node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, intrinsicHeights[index]!);
        const childY = slot.y + alignOffset(node.align, allocatedHeight, childHeight);
        const childWidth = widths[index]!;
        box.children.push(
            childWidth === 0
                ? zeroWidthBox(entry.component, childX, childY, childHeight, box)
                : withParent(
                      layoutComponent(context, entry.component, {
                          x: childX,
                          y: childY,
                          width: childWidth,
                          height: childHeight,
                          clip: box.clip,
                      }),
                      box,
                  ),
        );
        childX += childWidth + node.gap;
    });
    return box;
}

function alignOffset(align: StackLayoutNode["align"], available: number, used: number): number {
    if (align === "center") return Math.floor((available - used) / 2);
    if (align === "end") return available - used;
    return 0;
}

/** A child squeezed to no width keeps its place in the tree but is never rendered. */
function zeroWidthBox(component: Component, x: number, y: number, height: number, parent: LayoutBox): LayoutBox {
    return {
        component,
        rect: { x, y, width: 0, height },
        clip: { x, y, width: 0, height: 0 },
        children: [],
        parent,
        layer: 0,
    };
}

function styleScrollbarCell(line: string, column: number, totalWidth: number, style: (text: string) => string): string {
    if (isImageLine(line)) return line;

    const graphemeRange = getGraphemeCellRange(line, column);
    const start = graphemeRange?.start ?? column;
    const end = graphemeRange?.end ?? column + 1;
    const before = sliceByColumn(line, 0, start, true);
    const target = sliceByColumn(line, start, end - start, true);
    const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);

    let targetPrefix = "";
    let targetIndex = 0;
    while (targetIndex < target.length) {
        const ansi = extractAnsiCode(target, targetIndex);
        if (!ansi) break;
        targetPrefix += ansi.code;
        targetIndex += ansi.length;
    }
    const targetText = target.slice(targetIndex) || " ".repeat(end - start);
    const beforePadding = " ".repeat(Math.max(0, start - visibleWidth(before)));
    return `${before}${beforePadding}${targetPrefix}${style(targetText)}${after}`;
}

export function getScrollbarGeometry(box: LayoutBox): ScrollbarGeometry | undefined {
    if (!box.scrollView?.isScrollbarVisible || box.rect.width <= 0 || box.rect.height <= 0) return undefined;

    const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
    const trackHeight = box.rect.height;

    const minThumbHeight = Math.min(2, trackHeight);
    const thumbHeight = Math.max(
        minThumbHeight,
        Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
    );
    const maxScrollTop = Math.max(0, contentHeight - trackHeight);
    const maxThumbTop = trackHeight - thumbHeight;
    const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((box.scrollView.scrollTop / maxScrollTop) * maxThumbTop);
    const column = box.rect.x + box.rect.width - 1;
    if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;

    return {
        column,
        trackTop: box.rect.y,
        trackHeight,
        thumbTop: box.rect.y + thumbOffset,
        thumbHeight,
        maxScrollTop,
    };
}

function paintScrollbar(box: LayoutBox, screen: string[], totalWidth: number): void {
    const geometry = getScrollbarGeometry(box);
    if (!geometry || !box.scrollView) return;

    for (let offset = 0; offset < geometry.thumbHeight; offset++) {
        const row = geometry.thumbTop + offset;
        if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= screen.length) continue;
        screen[row] = styleScrollbarCell(screen[row] ?? "", geometry.column, totalWidth, box.scrollView.scrollbarStyle);
    }
}

function paintBox(box: LayoutBox, screen: string[], totalWidth: number): void {
    if (box.lines) {
        const offset = box.lineOffset ?? 0;
        const firstRow = Math.max(box.rect.y, box.clip.y, 0);
        const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
        for (let row = firstRow; row < lastRow; row++) {
            const sourceLine = box.lines[offset + row - box.rect.y];
            if (sourceLine === undefined) continue;
            let line = sourceLine.replace(OSC133_ZONE_PREFIX, "");
            const imageMetadata = getKittyImageMetadata(line);
            if (imageMetadata) {
                const clipBottom = Math.min(screen.length, box.clip.y + box.clip.height);
                const visibleRows = Math.min(imageMetadata.rows, clipBottom - row);
                if (visibleRows < imageMetadata.rows) line = cropKittyImageLine(line, 0, visibleRows);
            }
            // Fast path: a full-width box painting onto an untouched row can use the
            // source line reference directly. Compositing here would rebuild the row
            // string through ANSI/grapheme segmentation every frame; padding is
            // unnecessary because rows are written with erase-line and the final
            // width clamp still truncates over-wide lines.
            if (box.rect.x === 0 && box.rect.width >= totalWidth && (isImageLine(line) || !screen[row])) {
                screen[row] = line;
            } else {
                screen[row] = compositeTuiLine(screen[row] ?? "", line, box.rect.x, box.rect.width, totalWidth);
            }
        }
    }
    for (const child of box.children) paintBox(child, screen, totalWidth);

    if (box.scrollView && box.scrollContentLines && box.scrollView.scrollTop > 0 && box.rect.height > 0) {
        for (let imageRow = box.scrollView.scrollTop - 1; imageRow >= 0; imageRow--) {
            const imageLine = box.scrollContentLines[imageRow] ?? "";
            const metadata = getKittyImageMetadata(imageLine);
            if (metadata) {
                const hiddenRows = box.scrollView.scrollTop - imageRow;
                if (hiddenRows < metadata.rows) {
                    const visibleRows = Math.min(box.rect.height, metadata.rows - hiddenRows);
                    const cropped = cropKittyImageLine(imageLine, hiddenRows, visibleRows);
                    if (box.rect.x === 0 && box.rect.width >= totalWidth) screen[box.rect.y] = cropped;
                }
                break;
            }
            if (imageLine !== "") break;
        }
    }

    paintScrollbar(box, screen, totalWidth);
}

export function renderLayoutFrame(
    root: Component,
    width: number,
    height: number,
    requestRender: () => void,
): LayoutFrame {
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    const context: LayoutContext = {
        viewport: { width: safeWidth, height: safeHeight },
        renderCache: new Map(),
        requestRender,
        primaryScrollView: undefined,
    };
    const screen = { x: 0, y: 0, width: safeWidth, height: safeHeight };
    const rootBox = layoutComponent(context, root, { ...screen, clip: screen });
    const lines = Array.from({ length: safeHeight }, () => "");
    paintBox(rootBox, lines, safeWidth);
    return {
        root: rootBox,
        width: safeWidth,
        height: safeHeight,
        lines,
        ...(context.primaryScrollView === undefined ? {} : { primaryScrollView: context.primaryScrollView }),
    };
}

function containsPoint(rect: LayoutRect, x: number, y: number): boolean {
    return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function getScrollViewBox(frame: LayoutFrame, scrollView: ScrollView): LayoutBox | undefined {
    const visit = (box: LayoutBox): LayoutBox | undefined => {
        if (box.scrollView === scrollView) return box;
        for (const child of box.children) {
            const match = visit(child);
            if (match) return match;
        }
        return undefined;
    };
    return visit(frame.root);
}

export function getScrollViewsAt(frame: LayoutFrame, x: number, y: number): ScrollView[] {
    const result: Array<{ scrollView: ScrollView; depth: number }> = [];
    const visit = (box: LayoutBox, depth: number): void => {
        if (!containsPoint(box.clip, x, y)) return;
        if (box.scrollView && containsPoint(box.rect, x, y)) result.push({ scrollView: box.scrollView, depth });
        for (const child of box.children) visit(child, depth + 1);
    };
    visit(frame.root, 0);
    result.sort((a, b) => b.depth - a.depth);
    return result.map((entry) => entry.scrollView);
}
