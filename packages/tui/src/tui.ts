/**
 * Minimal TUI implementation with differential rendering
 */

import * as os from "node:os";
import * as path from "node:path";
import { brandEnv, CONFIG_DIR_NAME } from "./brand";
import { type Component, Container, containsComponent, isFocusable, type TuiInputListener } from "./component";
import { isKeyRelease, matchesKey } from "./keys";
import type { OverlayFocusRestorePolicy } from "./overlay/focus-restore";
import { type OverlayHit, type OverlayHost, OverlayStack } from "./overlay/stack";
import type { OverlayHandle, OverlayOptions, OverlayRect } from "./overlay/types";
import { logRenderError } from "./render-error-log";
import { applyLineResets, extractCursorPosition } from "./render/line-composite";
import { RenderScheduler } from "./render/scheduler";
import type { Terminal } from "./terminal";
import type { RgbColor, TerminalColorScheme } from "./terminal-colors";
import { BackgroundColorQueries } from "./terminal-queries/background-color";
import { consumeCellSizeReport, queryCellSize } from "./terminal-queries/cell-size";
import { ColorSchemeReports } from "./terminal-queries/color-scheme";
import { stripTerminalReports } from "./terminal-queries/strip-reports";
import { WidthCalibrationProbe } from "./terminal-queries/width-calibration";
import { visibleWidth } from "./utils";

// The pieces TuiBase is built from live in their own modules; they are
// re-exported here so existing imports of "./tui" keep working.
export {
    type Component,
    Container,
    CURSOR_MARKER,
    type Focusable,
    isFocusable,
    type TuiInputListener,
    type TuiInputListenerResult,
} from "./component";
export { compositeTuiLine } from "./render/line-composite";
export type {
    OverlayAnchor,
    OverlayBounds,
    OverlayHandle,
    OverlayMargin,
    OverlayOptions,
    OverlayRect,
    OverlayUnfocusOptions,
    SizeValue,
} from "./overlay/types";
export { visibleWidth };

/** A minutely no-op: Bun does not keep max-delay (2^31-1 ms) intervals ref'd. */
const KEEP_ALIVE_INTERVAL_MS = 60_000;

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
    /** Leave renderer output in place for another TUI taking over the same terminal. */
    preserveScreen?: boolean;
}

export interface TUI extends Component {
    readonly mode: TuiMode;
    children: Component[];
    terminal: Terminal;
    onDebug?: () => void;
    /** The terminal window regained focus (fullscreen only; needs focus reporting). */
    onFocusIn?: () => void;
    readonly fullRedraws: number;
    addChild(component: Component): void;
    removeChild(component: Component): void;
    clear(): void;
    getShowHardwareCursor(): boolean;
    setShowHardwareCursor(enabled: boolean): void;
    getClearOnShrink(): boolean;
    setClearOnShrink(enabled: boolean): void;
    setFocus(component: Component | null): void;
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
    hideOverlay(): void;
    hasOverlay(): boolean;
    start(): void;
    stop(options?: TuiStopOptions): void;
    renderNow(force?: boolean): void;
    requestRender(force?: boolean): void;
    addInputListener(listener: TuiInputListener): () => void;
    removeInputListener(listener: TuiInputListener): void;
    onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
    setTerminalColorSchemeNotifications(enabled: boolean): void;
    queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
    queryTerminalColorScheme(options: { timeoutMs: number }): Promise<TerminalColorScheme | undefined>;
    // ---- loop-local (keep across pi-mono syncs) ----
    /** True only while a frame is being composed. */
    isRendering(): boolean;
    /** Identifies the frame being composed; for within-frame memoization. */
    readonly renderFrameId: number;
    /** Rows the components rendered last frame, before any overlay padding. */
    getContentHeight(): number;
    /** The next frame is a NEW frame, not a continuation of this one. */
    resetFrame(): void;
    /** Set the terminal title through the renderer rather than behind its back. */
    setTitle(title: string): void;
}

export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

export interface ViewportTUI extends TUI {
    readonly [VIEWPORT_TUI]: true;
    setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
    return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container implements TUI {
    abstract readonly mode: TuiMode;
    public terminal: Terminal;
    private focusedComponent: Component | null = null;
    private inputListeners = new Set<TuiInputListener>();

    /** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
    public onDebug?: () => void;
    public onFocusIn?: () => void;
    private showHardwareCursor = brandEnv("HARDWARE_CURSOR") === "1";
    private clearOnShrink = brandEnv("CLEAR_ON_SHRINK") === "1";
    protected fullRedrawCount = 0;
    protected stopped = false;
    // loop-local render bookkeeping. `contentHeight` is where the frame ENDS,
    // which is what an overlay anchored to the bottom of it needs — compositing
    // pads the frame out to the full height, so previousLines.length stops
    // answering that question exactly when it is being relied on.
    protected renderingFrame = false;
    protected frameId = 0;
    protected contentHeight = 0;
    protected frameReset = false;
    private keepAliveTimer: ReturnType<typeof setInterval> | undefined;
    protected readonly logDirectory: string;

    private readonly scheduler = new RenderScheduler(
        () => this.renderFrame(),
        () => this.stopped,
    );
    private readonly overlays = new OverlayStack(this.createOverlayHost());
    private readonly backgroundColor = new BackgroundColorQueries(this.terminalWriter());
    private readonly colorScheme = new ColorSchemeReports(this.terminalWriter());
    // loop-local: complex-script width calibration probe.
    private readonly widthProbe = new WidthCalibrationProbe(
        this.terminalWriter(),
        // Everything measured so far used the wrong widths; force a full
        // repaint (same path as a terminal resize).
        () => this.requestRender(true),
    );

    get hasOverlayEntries(): boolean {
        return !this.overlays.isEmpty;
    }

    constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
        super();
        this.terminal = terminal;
        this.logDirectory = logDirectory ?? brandEnv("AGENT_DIR") ?? path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
        if (showHardwareCursor !== undefined) {
            this.showHardwareCursor = showHardwareCursor;
        }
    }

    protected abstract doRender(): void;

    /**
     * loop-local (keep across pi-mono syncs): told about a frame that threw.
     *
     * Called once per DISTINCT failure (see render-error-log.ts). Nothing can
     * be painted by the time this runs, so it is for surfacing and logging,
     * not for drawing.
     */
    public onRenderError?: (error: unknown) => void;

    /**
     * loop-local: the one door every frame goes through.
     *
     * `doRender` used to be called bare from three schedulers, so a component
     * that threw escaped to the process's uncaught-exception handler — which
     * surfaced the error in the chat and asked for a repaint, which threw
     * again. Nothing ever painted, the chat grew by an error line per frame,
     * and the UI looked frozen: no typing, no scrolling, until a restart
     * rebuilt the components that had been throwing. A frame that fails now
     * fails ALONE. It is logged once, reported once, and never re-requests
     * itself, so the next frame comes from the next real event and the UI
     * recovers the moment whatever broke stops breaking.
     */
    private renderFrame(): void {
        try {
            this.doRender();
        } catch (error) {
            if (logRenderError("frame", error, this.logDirectory)) this.onRenderError?.(error);
        }
    }

    protected resetRenderState(): void {}

    protected beforeTerminalStart(): void {}

    protected afterTerminalStart(): void {}

    protected handleTerminalResize(): void {
        this.requestRender();
    }

    protected beforeTerminalStop(_options: TuiStopOptions): void {}

    protected afterTerminalStop(_options: TuiStopOptions): void {}

    get fullRedraws(): number {
        return this.fullRedrawCount;
    }

    /** True only while a frame is being composed. */
    isRendering(): boolean {
        return this.renderingFrame;
    }

    /**
     * Identifies the frame being composed, so a caller can memoize a
     * measurement WITHIN one frame without carrying it across frames — where
     * it would be stale in exactly the case that matters.
     */
    get renderFrameId(): number {
        return this.frameId;
    }

    getContentHeight(): number {
        return this.contentHeight;
    }

    /**
     * The next frame is a NEW frame, not a continuation of this one.
     *
     * The main-screen renderer's model is that frame line i is at a known place
     * on the screen, kept true by diffing this frame against the last one BY
     * INDEX. That only means anything while the two frames are the same
     * conversation with more added. Rebuild the transcript — /new, /clear, a
     * mode switch, a resumed session — and index 0 of the new frame has nothing
     * to do with index 0 of the old one, so the diff concludes the top of the
     * screen is unchanged and leaves the old conversation under a new prompt.
     *
     * A signal, not something to detect: a rebuilt transcript and a line
     * inserted above the window look identical from here and want opposite
     * treatment. Only the caller knows which it did. The alt screen repaints
     * whole frames, so it simply has nothing to do with this.
     */
    resetFrame(): void {
        this.frameReset = true;
    }

    /**
     * Titles go through the renderer, never straight at stdout: a caller
     * writing escape sequences behind its back desynchronises the cursor
     * bookkeeping the differential renderer depends on.
     */
    setTitle(title: string): void {
        this.terminal.setTitle(title);
    }

    getShowHardwareCursor(): boolean {
        return this.showHardwareCursor;
    }

    setShowHardwareCursor(enabled: boolean): void {
        if (this.showHardwareCursor === enabled) return;
        this.showHardwareCursor = enabled;
        if (!enabled) {
            this.terminal.hideCursor();
        }
        this.requestRender();
    }

    getClearOnShrink(): boolean {
        return this.clearOnShrink;
    }

    /**
     * Set whether to trigger full re-render when content shrinks.
     * When true (default), empty rows are cleared when content shrinks.
     * When false, empty rows remain (reduces redraws on slower terminals).
     */
    setClearOnShrink(enabled: boolean): void {
        this.clearOnShrink = enabled;
    }

    getFocusedComponent(): Component | null {
        return this.focusedComponent;
    }

    setFocus(component: Component | null): void {
        this.setFocusInternal(component, "clear");
    }

    private setFocusInternal(requested: Component | null, policy: OverlayFocusRestorePolicy): void {
        const next = this.overlays.resolveFocusRequest(this.focusedComponent, requested, policy);
        if (isFocusable(this.focusedComponent)) {
            this.focusedComponent.focused = false;
        }
        this.focusedComponent = next;
        if (isFocusable(next)) {
            next.focused = true;
        }
        this.overlays.noteFocused(next);
    }

    /**
     * The terminal is read through a getter because field initializers run
     * before the constructor assigns it. Plain focus requests go through the
     * public setFocus, exactly as a caller's would.
     */
    private createOverlayHost(): OverlayHost {
        const tui = this;
        return {
            get terminal() {
                return tui.terminal;
            },
            getFocusedComponent: () => this.focusedComponent,
            setFocus: (component, policy = "clear") =>
                policy === "preserve" ? this.setFocusInternal(component, policy) : this.setFocus(component),
            requestRender: () => this.requestRender(),
            isComponentMounted: (component) => this.isComponentMounted(component),
        };
    }

    /** Queries write through the live terminal, which is assigned after field initializers run. */
    private terminalWriter(): Pick<Terminal, "write"> {
        return { write: (data) => this.terminal.write(data) };
    }

    protected getMountedRoots(): readonly Component[] {
        return this.children;
    }

    private isComponentMounted(component: Component): boolean {
        return this.getMountedRoots().some((child) => containsComponent(child, component));
    }

    /**
     * Show an overlay component with configurable positioning and sizing.
     * Returns a handle to control the overlay's visibility.
     */
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
        return this.overlays.show(component, options);
    }

    /** Hide the topmost overlay and restore previous focus. */
    hideOverlay(): void {
        this.overlays.hideTopmost();
    }

    /** Check if there are any visible overlays */
    hasOverlay(): boolean {
        return this.overlays.hasVisible();
    }

    /** Check if the focused component is a visible overlay */
    protected isOverlayFocused(): boolean {
        return this.overlays.isVisibleOverlay(this.focusedComponent);
    }

    override invalidate(): void {
        for (const root of this.getMountedRoots()) root.invalidate();
        this.overlays.invalidate();
    }

    start(): void {
        this.stopped = false;
        this.pinEventLoop();
        this.beforeTerminalStart();
        this.terminal.start(
            (data) => this.handleTerminalInput(data),
            () => this.handleTerminalResize(),
        );
        this.afterTerminalStart();
        this.terminal.hideCursor();
        this.colorScheme.start();
        queryCellSize(this.terminal);
        this.widthProbe.start();
        this.requestRender();
    }

    /**
     * LOCAL CHANGE (keep across pi-mono syncs): a ref'd long-interval timer
     * pins the event loop for the TUI's lifetime. Bun's tty stdin does not
     * reliably hold the loop before the first byte ever arrives, so in an
     * unattended pty the process silently exited the moment the width-probe
     * timeout (the last live timer) fired.
     */
    private pinEventLoop(): void {
        if (!this.keepAliveTimer) {
            this.keepAliveTimer = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
        }
    }

    private unpinEventLoop(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = undefined;
        }
    }

    addInputListener(listener: TuiInputListener): () => void {
        this.inputListeners.add(listener);
        return () => {
            this.inputListeners.delete(listener);
        };
    }

    removeInputListener(listener: TuiInputListener): void {
        this.inputListeners.delete(listener);
    }

    onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
        return this.colorScheme.onChange(listener);
    }

    setTerminalColorSchemeNotifications(enabled: boolean): void {
        this.colorScheme.setNotifications(enabled, !this.stopped);
    }

    stop(options: TuiStopOptions = {}): void {
        this.stopped = true;
        this.scheduler.cancel();
        this.unpinEventLoop();
        this.widthProbe.cancel();
        this.colorScheme.stop();
        this.beforeTerminalStop(options);
        this.terminal.showCursor();
        this.terminal.stop();
        this.afterTerminalStop(options);
    }

    renderNow(force = false): void {
        if (force) this.resetRenderState();
        this.scheduler.renderNow();
    }

    requestRender(force = false): void {
        if (force) {
            this.resetRenderState();
            this.scheduler.requestImmediate();
            return;
        }
        this.scheduler.request();
    }

    private handleTerminalInput(data: string): void {
        const input = this.filterTerminalInput(data);
        if (input === undefined) return;
        if (matchesKey(input, "shift+ctrl+d") && this.onDebug) {
            this.onDebug();
            return;
        }
        this.overlays.restoreFocusBeforeInput();
        this.deliverToFocused(input);
    }

    /**
     * Take everything that is not a key press out of the input: terminal
     * reports, probe replies, and whatever input listeners consume.
     * Undefined when nothing is left for the focused component.
     */
    private filterTerminalInput(data: string): string | undefined {
        // LOCAL CHANGE (keep across pi-mono syncs). Reports are stripped out of
        // the chunk rather than matched against the whole of it, and stripped
        // whether or not a query is still pending. Upstream's whole-chunk,
        // pending-only match misses two real cases: two replies batched into
        // one chunk, and a reply that arrives after its query timed out. Either
        // then falls through to the key handling — and an OSC 11 reply ENDS IN
        // BEL, which is ctrl+g, which loop binds to "continue". A stray report
        // sends a prompt nobody typed.
        let input = stripTerminalReports(data, {
            onBackgroundColor: (report) => this.backgroundColor.deliver(report),
            onColorScheme: (report) => this.colorScheme.deliver(report),
        });
        if (input.length === 0) return undefined;
        if (this.widthProbe.isPending) {
            input = this.widthProbe.consume(input);
            if (input.length === 0) return undefined;
        }
        const listened = this.runInputListeners(input);
        if (listened === undefined) return undefined;
        // Consume terminal cell size responses without blocking unrelated input.
        if (this.consumeCellSizeResponse(listened)) return undefined;
        return listened;
    }

    /** Undefined when a listener consumed the input or left nothing of it. */
    private runInputListeners(data: string): string | undefined {
        let current = data;
        for (const listener of this.inputListeners) {
            const result = listener(current);
            if (result?.consume) return undefined;
            if (result?.data !== undefined) current = result.data;
        }
        return current.length === 0 ? undefined : current;
    }

    private consumeCellSizeResponse(data: string): boolean {
        const result = consumeCellSizeReport(data);
        if (result === "updated") {
            // Invalidate all components so images re-render with correct dimensions.
            this.invalidate();
            this.requestRender();
        }
        return result !== "none";
    }

    /** The focused component decides what keys mean, Ctrl+C included. */
    private deliverToFocused(data: string): void {
        const focused = this.focusedComponent;
        if (!focused?.handleInput) return;
        // Filter out key release events unless component opts in
        if (isKeyRelease(data) && !focused.wantsKeyRelease) return;
        focused.handleInput(data);
        // Keyboard input is latency-sensitive. Avoid the throttled timer path,
        // where even setTimeout(0) can take a full 16 ms tick on Windows.
        this.scheduler.requestImmediate();
    }

    /** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
    protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
        return this.overlays.composite(lines, termWidth, termHeight);
    }

    /** Where an overlay was last painted, or undefined if it is not visible. */
    getOverlayRect(component: Component): OverlayRect | undefined {
        return this.overlays.getRect(component);
    }

    /** The topmost visible overlay under a 0-based screen cell; see {@link OverlayStack.hitTest}. */
    hitTestOverlay(x: number, y: number): OverlayHit | undefined {
        return this.overlays.hitTest(x, y);
    }

    protected applyLineResets(lines: string[]): string[] {
        return applyLineResets(lines);
    }

    protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
        return extractCursorPosition(lines, height);
    }

    /**
     * Query the terminal's default background color with OSC 11 (`ESC ] 11 ; ? BEL`).
     * @returns Promise containing the parsed RGB color, or undefined if it times out or fails to parse.
     */
    queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
        return this.backgroundColor.query(timeoutMs);
    }

    /**
     * Query the terminal's color-scheme preference with DSR (`CSI ? 996 n`).
     * Terminals that support the color palette notification protocol reply with
     * `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light.
     */
    queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
        return this.colorScheme.query(timeoutMs);
    }
}
