import type { Component } from "../component";
import { compositeOverlays, placeOverlay } from "./compositor";
import {
    type BlockedState,
    type FocusRestoreState,
    OverlayFocusRestore,
    type OverlayFocusRestorePolicy,
    type OverlayStackEntry,
} from "./focus-restore";
import type { OverlayHandle, OverlayOptions, OverlayRect, OverlayUnfocusOptions } from "./types";

/** What the overlay stack needs from the TUI that owns it. */
export interface OverlayHost {
    readonly terminal: { readonly columns: number; readonly rows: number; hideCursor(): void };
    getFocusedComponent(): Component | null;
    setFocus(component: Component | null, policy?: OverlayFocusRestorePolicy): void;
    requestRender(): void;
    isComponentMounted(component: Component): boolean;
}

export interface OverlayHit {
    component: Component;
    rect: OverlayRect;
    localX: number;
    localY: number;
}

/**
 * Modal components drawn on top of the base content: their order, their
 * visibility, who gets focus when one is shown, hidden or released, and where
 * each was painted last frame.
 */
export class OverlayStack {
    private entries: OverlayStackEntry[] = [];
    private focusOrderCounter = 0;
    private readonly focusRestore = new OverlayFocusRestore();

    /**
     * loop-local (keep across pi-mono syncs): where each visible overlay was
     * painted on the last composite.
     *
     * Overlay geometry is computed every frame and then thrown away, so nothing
     * downstream can answer "which overlay is under this mouse click?" without
     * duplicating the whole layout resolution — and a duplicate would drift.
     * Recording it here costs one map write per visible overlay per frame.
     */
    private rects = new Map<Component, OverlayRect>();

    constructor(private readonly host: OverlayHost) {}

    get isEmpty(): boolean {
        return this.entries.length === 0;
    }

    /** Show an overlay and return a handle that controls it. */
    show(component: Component, options?: OverlayOptions): OverlayHandle {
        const entry: OverlayStackEntry = {
            component,
            ...(options === undefined ? {} : { options }),
            preFocus: this.host.getFocusedComponent(),
            hidden: false,
            focusOrder: ++this.focusOrderCounter,
        };
        this.entries.push(entry);
        // Only focus if overlay is actually visible
        if (!options?.nonCapturing && this.isVisible(entry)) {
            this.host.setFocus(component);
        }
        this.host.terminal.hideCursor();
        this.host.requestRender();
        return this.createHandle(entry);
    }

    /** Hide the topmost overlay and restore previous focus. */
    hideTopmost(): void {
        const overlay = this.entries[this.entries.length - 1];
        if (overlay) this.remove(overlay);
    }

    hasVisible(): boolean {
        return this.entries.some((entry) => this.isVisible(entry));
    }

    isVisibleOverlay(component: Component | null): boolean {
        return this.entries.some((entry) => entry.component === component && this.isVisible(entry));
    }

    invalidate(): void {
        for (const entry of this.entries) entry.component.invalidate();
    }

    /**
     * Decide where focus really goes when `requested` is asked for, keeping the
     * focus-restore bookkeeping in step. Called before the focus changes.
     */
    resolveFocusRequest(
        previous: Component | null,
        requested: Component | null,
        policy: OverlayFocusRestorePolicy,
    ): Component | null {
        const state = this.liveRestoreState();
        if (requested === null) return this.resolveFocusCleared(previous, state, policy);
        if (this.entries.some((entry) => entry.component === requested)) return requested;
        return this.resolveFocusLeavingOverlay(previous, requested, state);
    }

    /** Called after focus changed: a focused visible overlay earns its focus back later. */
    noteFocused(focused: Component | null): void {
        const overlay = focused ? this.visibleEntryFor(focused) : undefined;
        if (overlay) this.focusRestore.markEligible(overlay);
    }

    /**
     * Before routing a key: move focus off an overlay that stopped being
     * visible, and back onto one that is owed it.
     */
    restoreFocusBeforeInput(): void {
        this.leaveInvisibleFocusedOverlay();
        this.returnFocusToOwedOverlay();
    }

    /** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
    composite(lines: string[], termWidth: number, termHeight: number): string[] {
        if (this.entries.length === 0) return lines;
        for (const entry of this.entries) entry.bounds = undefined;

        const visible = this.entries.filter((entry) => this.isVisible(entry));
        visible.sort((a, b) => a.focusOrder - b.focusOrder);
        const placed = visible.map((entry) => {
            const overlay = placeOverlay(entry.component, entry.options, termWidth, termHeight);
            entry.bounds = { row: overlay.row, col: overlay.col, width: overlay.width, height: overlay.lines.length };
            return overlay;
        });

        // Rebuilt every composite so an overlay that was hidden, moved or
        // resized never leaves a stale rect behind for the hit test.
        this.rects.clear();
        for (const p of placed) {
            this.rects.set(p.component, { row: p.row, col: p.col, width: p.width, height: p.lines.length });
        }
        return compositeOverlays(lines, placed, termWidth, termHeight);
    }

    /** Where an overlay was last painted, or undefined if it is not visible. */
    getRect(component: Component): OverlayRect | undefined {
        return this.rects.get(component);
    }

    /**
     * The topmost visible overlay covering a screen cell, with the point
     * translated into the overlay's own coordinates.
     *
     * `x`/`y` are 0-based screen coordinates — SGR mouse reports are 1-based,
     * so subtract one before calling. Later entries in the stack are painted
     * over earlier ones, so the search runs backwards.
     */
    hitTest(x: number, y: number): OverlayHit | undefined {
        const entries = [...this.rects.entries()].reverse();
        for (const [component, rect] of entries) {
            if (y < rect.row || y >= rect.row + rect.height) continue;
            if (x < rect.col || x >= rect.col + rect.width) continue;
            return { component, rect, localX: x - rect.col, localY: y - rect.row };
        }
        return undefined;
    }

    private createHandle(entry: OverlayStackEntry): OverlayHandle {
        const { component } = entry;
        return {
            hide: () => {
                if (this.entries.includes(entry)) this.remove(entry);
            },
            setHidden: (hidden) => this.setHidden(entry, hidden),
            isHidden: () => entry.hidden,
            focus: () => {
                if (!this.isLive(entry)) return;
                this.focusEntry(entry);
                this.host.requestRender();
            },
            unfocus: (options) => this.unfocus(entry, options),
            isFocused: () => this.host.getFocusedComponent() === component,
            getBounds: () => (this.isLive(entry) && entry.bounds ? { ...entry.bounds } : undefined),
        };
    }

    private remove(entry: OverlayStackEntry): void {
        this.focusRestore.clearFor(entry);
        this.retargetPreFocus(entry);
        this.entries.splice(this.entries.indexOf(entry), 1);
        this.releaseFocusFrom(entry);
        if (this.entries.length === 0) this.host.terminal.hideCursor();
        this.host.requestRender();
    }

    private setHidden(entry: OverlayStackEntry, hidden: boolean): void {
        if (entry.hidden === hidden) return;
        entry.hidden = hidden;
        if (hidden) {
            this.focusRestore.clearFor(entry);
            this.releaseFocusFrom(entry);
        } else if (!entry.options?.nonCapturing && this.isVisible(entry)) {
            this.focusEntry(entry);
        }
        this.host.requestRender();
    }

    private unfocus(entry: OverlayStackEntry, options: OverlayUnfocusOptions | undefined): void {
        const isFocused = this.host.getFocusedComponent() === entry.component;
        if (!isFocused && !this.focusRestore.isPendingFor(entry)) return;
        const state = this.focusRestore.state;
        if (
            state.status === "blocked" &&
            state.overlay === entry &&
            this.host.getFocusedComponent() === state.blockedBy
        ) {
            // Something else holds focus right now; only change where it resumes.
            if (options)
                this.focusRestore.block(entry, state.blockedBy, { status: "focus-target", target: options.target });
            else this.focusRestore.clear();
            this.host.requestRender();
            return;
        }
        this.focusRestore.clearFor(entry);
        if (isFocused || options) {
            const topVisible = this.topmostVisible();
            const fallback = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
            this.host.setFocus(options ? options.target : fallback);
        }
        this.host.requestRender();
    }

    /** Bring an overlay to the visual front and focus it. */
    private focusEntry(entry: OverlayStackEntry): void {
        entry.focusOrder = ++this.focusOrderCounter;
        this.host.setFocus(entry.component);
    }

    /** If the overlay had focus, hand it to the next visible overlay or to whoever had it before. */
    private releaseFocusFrom(entry: OverlayStackEntry): void {
        if (this.host.getFocusedComponent() !== entry.component) return;
        this.host.setFocus(this.topmostVisible()?.component ?? entry.preFocus);
    }

    private resolveFocusCleared(
        previous: Component | null,
        state: FocusRestoreState,
        policy: OverlayFocusRestorePolicy,
    ): Component | null {
        if (state.status === "blocked" && state.blockedBy === previous) return this.focusRestore.resolveBlocked(state);
        if (policy === "clear") this.focusRestore.clear();
        return null;
    }

    private resolveFocusLeavingOverlay(
        previous: Component | null,
        requested: Component,
        state: FocusRestoreState,
    ): Component | null {
        if (state.status === "blocked" && state.blockedBy === previous) {
            return this.handOverBlockedFocus(state, requested);
        }
        const previousOverlay = previous ? this.visibleEntryFor(previous) : undefined;
        if (
            previousOverlay &&
            state.status !== "inactive" &&
            state.overlay === previousOverlay &&
            !this.isFocusAncestor(previousOverlay, requested)
        ) {
            this.focusRestore.block(previousOverlay, requested, { status: "restore-overlay" });
        }
        return requested;
    }

    /** The blocker is passing focus on: resume now, or let the new holder keep blocking. */
    private handOverBlockedFocus(state: BlockedState, requested: Component): Component | null {
        if (state.resume.status === "focus-target" || !this.host.isComponentMounted(state.blockedBy)) {
            return this.focusRestore.resolveBlocked(state);
        }
        this.focusRestore.block(state.overlay, requested, state.resume);
        return requested;
    }

    /** Visibility can change on resize or through the visible() callback. */
    private leaveInvisibleFocusedOverlay(): void {
        const focused = this.host.getFocusedComponent();
        const focusedOverlay = this.entries.find((entry) => entry.component === focused);
        if (!focusedOverlay || this.isVisible(focusedOverlay)) return;
        const topVisible = this.topmostVisible();
        if (topVisible) this.host.setFocus(topVisible.component);
        else this.host.setFocus(focusedOverlay.preFocus, "preserve");
    }

    private returnFocusToOwedOverlay(): void {
        const focused = this.host.getFocusedComponent();
        if (this.entries.some((entry) => entry.component === focused)) return;
        const state = this.liveRestoreState();
        if (state.status === "eligible") {
            this.host.setFocus(state.overlay.component);
        } else if (state.status === "blocked" && state.blockedBy !== focused) {
            if (state.resume.status === "restore-overlay") {
                this.host.setFocus(state.overlay.component);
            } else {
                this.focusRestore.clear();
                this.host.setFocus(state.resume.target);
            }
        }
    }

    private liveRestoreState(): FocusRestoreState {
        return this.focusRestore.visibleState((overlay) => this.isLive(overlay));
    }

    private isFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
        const visited = new Set<Component>();
        let current = entry.preFocus;
        while (current && !visited.has(current)) {
            visited.add(current);
            if (current === component) return true;
            current = this.entries.find((overlay) => overlay.component === current)?.preFocus ?? null;
        }
        return false;
    }

    private retargetPreFocus(removed: OverlayStackEntry): void {
        for (const overlay of this.entries) {
            if (overlay !== removed && overlay.preFocus === removed.component) {
                overlay.preFocus = removed.preFocus;
            }
        }
    }

    private isLive(entry: OverlayStackEntry): boolean {
        return this.entries.includes(entry) && this.isVisible(entry);
    }

    private isVisible(entry: OverlayStackEntry): boolean {
        if (entry.hidden) return false;
        return entry.options?.visible?.(this.host.terminal.columns, this.host.terminal.rows) ?? true;
    }

    private visibleEntryFor(component: Component): OverlayStackEntry | undefined {
        return this.entries.find((entry) => entry.component === component && this.isVisible(entry));
    }

    /** Find the visual-frontmost visible capturing overlay, if any */
    private topmostVisible(): OverlayStackEntry | undefined {
        let topmost: OverlayStackEntry | undefined;
        for (const overlay of this.entries) {
            if (overlay.options?.nonCapturing || !this.isVisible(overlay)) continue;
            if (!topmost || overlay.focusOrder > topmost.focusOrder) topmost = overlay;
        }
        return topmost;
    }
}
