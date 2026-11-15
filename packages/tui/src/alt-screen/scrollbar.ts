import type { ScrollView } from "../components/scroll-view";
import { getScrollbarGeometry, getScrollViewBox, getScrollViewsAt, type ScrollbarGeometry } from "../layout";
import { isPrimaryPress, type SgrMouseEvent } from "./mouse-events";
import type { ViewportHost } from "./viewport-host";

interface ScrollbarDrag {
    scrollView: ScrollView;
    grabOffset: number;
}

interface ScrollbarTarget {
    scrollView: ScrollView;
    geometry: ScrollbarGeometry;
}

/** Scrollbar thumbs: highlight under the pointer, and drag to scroll. */
export class ScrollbarControl {
    private drag?: ScrollbarDrag;
    private hover?: ScrollView;

    constructor(private readonly host: ViewportHost) {}

    get isDragging(): boolean {
        return this.drag !== undefined;
    }

    /**
     * Continue or end a drag, or start one on a thumb press. True when the
     * event was the scrollbar's. `onDragStart` runs when a new drag begins.
     */
    handleMouse(event: SgrMouseEvent, onDragStart: () => void): boolean {
        if (this.drag) {
            if (event.release) this.stopDrag();
            else this.dragTo(this.drag, event.y);
            return true;
        }
        if (!isPrimaryPress(event)) return false;
        const target = this.targetAt(event.x, event.y);
        if (!target) return false;
        onDragStart();
        this.setHover(target.scrollView);
        this.drag = { scrollView: target.scrollView, grabOffset: event.y - target.geometry.thumbTop };
        return true;
    }

    updateHover(x: number, y: number): void {
        this.setHover(this.targetAt(x, y)?.scrollView);
    }

    stopHover(): void {
        this.setHover(undefined);
    }

    stopDrag(): void {
        this.drag = undefined;
    }

    /** Move the thumb so the grabbed point follows the pointer. */
    private dragTo(drag: ScrollbarDrag, pointerY: number): void {
        const layout = this.host.layout();
        const box = layout ? getScrollViewBox(layout, drag.scrollView) : undefined;
        const geometry = box ? getScrollbarGeometry(box) : undefined;
        if (!geometry) return;
        const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
        const thumbOffset = Math.max(0, Math.min(maxThumbOffset, pointerY - geometry.trackTop - drag.grabOffset));
        const scrollTop = maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
        drag.scrollView.scrollTo(scrollTop);
    }

    private targetAt(x: number, y: number): ScrollbarTarget | undefined {
        const layout = this.host.layout();
        if (this.host.hasOverlay() || !layout) return undefined;
        for (const scrollView of getScrollViewsAt(layout, x, y)) {
            const box = getScrollViewBox(layout, scrollView);
            const geometry = box ? getScrollbarGeometry(box) : undefined;
            if (
                geometry &&
                x === geometry.column &&
                y >= geometry.thumbTop &&
                y < geometry.thumbTop + geometry.thumbHeight
            ) {
                return { scrollView, geometry };
            }
        }
        return undefined;
    }

    private setHover(scrollView: ScrollView | undefined): void {
        if (scrollView === this.hover) return;
        this.hover?.setScrollbarActive(false);
        this.hover = scrollView;
        this.hover?.setScrollbarActive(true);
    }
}
