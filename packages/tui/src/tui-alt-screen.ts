import {
    compositeFlashes,
    compositeScrollToEndIndicator,
    type ScrollToEndIndicatorRect,
} from "./alt-screen/decorations";
import { KittyImageCache } from "./alt-screen/kitty-cache";
import {
    hasAlt,
    isMouseSequence,
    isPrimaryPress,
    parseSgrMouseEvent,
    parseWheelEvent,
    type SgrMouseEvent,
    type WheelEvent,
} from "./alt-screen/mouse-events";
import { buildScreenUpdate, deleteAllImagesFor } from "./alt-screen/screen-update";
import { ScrollbarControl } from "./alt-screen/scrollbar";
import { TranscriptSearch } from "./alt-screen/search";
import { TextSelection } from "./alt-screen/selection";
import {
    DISABLE_AUTOWRAP,
    DISABLE_MOUSE,
    ENABLE_AUTOWRAP,
    ENTER_ALT_SCREEN,
    EXIT_ALT_SCREEN,
    FOCUS_IN,
    FOCUS_OUT,
    HIDE_CURSOR,
    mouseTrackingSequence,
    OSC133_PROMPT_START,
    OSC133_ZONE_PREFIX,
    SHOW_CURSOR,
} from "./alt-screen/terminal-modes";
import type { ViewportHost } from "./alt-screen/viewport-host";
import { viewportKeyActions } from "./alt-screen/viewport-keys";
import { AltScreenFlashContainer } from "./components/alt-screen-flash";
import { ScrollView } from "./components/scroll-view";
import { getKeybindings, type Keybinding } from "./keybindings";
import { isKeyRelease } from "./keys";
import { getScrollViewBox, getScrollViewsAt, type LayoutFrame, renderLayoutFrame } from "./layout";
import { CLEAR_LINE, SYNC_BEGIN, SYNC_END } from "./render/ansi";
import { logRenderError } from "./render-error-log";
import type { Terminal } from "./terminal";
import {
    getCapabilities,
    type ImageProtocol,
    isImageLine,
    setCapabilities,
    type TerminalCapabilities,
} from "./terminal-image";
import { type Component, CURSOR_MARKER, TuiBase, type TuiStopOptions, VIEWPORT_TUI, type ViewportTUI } from "./tui";
import { sliceByColumn, visibleWidth } from "./utils";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll";

const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
/**
 * loop-local (keep across pi-mono syncs). How long the wheel yields after a
 * keyboard-driven jump to the end (`scrollToBottom`), extended by every key
 * typed inside it.
 *
 * A trackpad keeps sending wheel-up events for a few hundred ms after the
 * fingers lift. A person who scrolls back and starts typing gets the jump
 * on the first key, then the tail drags the view up again, then the next
 * key jumps it back — the prompt and the completion list flicker in and out
 * until the tail dies. Terminals send no scroll phase, so time is the only
 * way to tell the tail from a hand on the wheel; and nobody types and flicks
 * at once, so keys extending the hold costs a real scroll nothing.
 */
const WHEEL_YIELDS_TO_KEYBOARD_MS = 400;

type InputResult = { consume?: boolean } | undefined;
const CONSUMED: InputResult = { consume: true };

export interface TuiAltScreenOptions {
    /**
     * Logical lines moved for each mouse-wheel event (default: 1). `"auto"` accelerates fast wheel
     * spins on terminals that send one event per notch. Alt+wheel moves five times as far.
     */
    wheelScrollLines?: WheelScrollLines;
    /** Capture mouse events for viewport scrolling and application-owned text selection. */
    mouse?: boolean;
    /** Style a non-current transcript search match. */
    searchMatchStyle?: (text: string) => string;
    /** Style the current transcript search match. */
    searchCurrentMatchStyle?: (text: string) => string;
    /** Style a transcript search navigation button. */
    searchNavigationButtonStyle?: (text: string, hovered: boolean) => string;
    /**
     * Render a clickable jump-to-end label. It is centered on the last row of a follow-end
     * primary scroll view while that view is scrolled away from its end.
     */
    scrollToEndIndicator?: () => string;
    /** Open an OSC 8 hyperlink activated with a primary-button click. */
    openUrl?: (url: string) => void;
    /** Handle an unmodified secondary-button press for clipboard paste. Currently enabled on Windows only. */
    onRightClickPaste?: () => void;
    /** Automatically copy selected text to the clipboard on mouse release (default: true). */
    copyOnSelect?: boolean;
    /**
     * Copy selected text to the system clipboard. Return `true` on success; the caller flashes
     * an error otherwise. When omitted, the selection is copied via an OSC 52 write.
     */
    copySelection?: (text: string) => Promise<boolean>;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
    readonly mode = "fullscreen" as const;
    readonly [VIEWPORT_TUI] = true as const;
    private previousScreen: string[] = [];
    private previousScreenWidth = 0;
    private previousScreenHeight = 0;
    private layoutRoot: Component | undefined;
    private currentLayout: LayoutFrame | undefined;
    private readonly implicitDocument: Component;
    private readonly implicitScrollView: ScrollView;
    /** Which mouse-tracking sequence this terminal got; re-asserted after start. */
    private mouseSequence = "";

    /**
     * loop-local (keep across pi-mono syncs): first refusal on a mouse event.
     *
     * Extension widgets are overlays the viewport knows nothing about, so they
     * need to claim a click before it becomes a text selection, a scrollbar
     * drag or a link activation. Returning true consumes the event, which is
     * also what suppresses all of the above — the same bargain the scrollbar
     * already makes when it captures a drag.
     *
     * Coordinates are as reported: 1-based.
     */
    private mouseInterceptor: ((event: SgrMouseEvent) => boolean) | undefined;
    /**
     * loop-local (keep across pi-mono syncs): told about a primary-button
     * CLICK — pressed and released on the same cell with no drag in between,
     * and not on a link (a link activates instead).
     *
     * The viewport recognises the gesture anyway — it has to, to tell a click
     * from the drag that makes a text selection — and this is it saying so. An
     * application can give a click a meaning of its own (loop selects the
     * transcript entry under the pointer) without taking the mouse away from
     * selection, which intercepting the press would do.
     *
     * Coordinates are 0-based cells, as the viewport counts them.
     */
    public onClick?: (x: number, y: number) => void;
    /** Wheel-up is dropped until this instant (see WHEEL_YIELDS_TO_KEYBOARD_MS). */
    private wheelHoldUntil = 0;
    private readonly flashes: AltScreenFlashContainer;
    private altScreenActive = false;
    private imageProtocol: ImageProtocol = null;
    private savedCapabilities?: TerminalCapabilities;
    private readonly kittyCache = new KittyImageCache();
    private scrollToEndIndicatorRect?: ScrollToEndIndicatorRect;
    private readonly wheelScroll: WheelScrollAccelerator;
    private readonly mouseEnabled: boolean;
    private readonly scrollToEndIndicator?: () => string;
    private readonly onRightClickPaste?: () => void;
    private copyOnSelect: boolean;
    private readonly copySelection?: (text: string) => Promise<boolean>;
    private readonly scrollbar: ScrollbarControl;
    private readonly search: TranscriptSearch;
    private readonly selection: TextSelection;
    private readonly viewportKeys: Array<[Keybinding, () => void]>;

    constructor(
        terminal: Terminal,
        showHardwareCursor?: boolean,
        logDirectory?: string,
        options: TuiAltScreenOptions = {},
    ) {
        super(terminal, showHardwareCursor, logDirectory);
        this.implicitDocument = {
            render: (width) => super.render(width),
            invalidate: () => {
                for (const child of this.children) child.invalidate();
            },
        };
        this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
        this.flashes = new AltScreenFlashContainer(() => this.requestRender());
        this.wheelScroll = new WheelScrollAccelerator(options.wheelScrollLines ?? 1);
        this.mouseEnabled = options.mouse ?? true;
        this.scrollToEndIndicator = options.scrollToEndIndicator;
        this.onRightClickPaste = options.onRightClickPaste;
        this.copyOnSelect = options.copyOnSelect ?? true;
        this.copySelection = options.copySelection;

        const host = this.viewportHost();
        this.scrollbar = new ScrollbarControl(host);
        this.search = new TranscriptSearch(
            { ...host, showOverlay: (component, overlayOptions) => this.showOverlay(component, overlayOptions) },
            {
                match: options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`),
                currentMatch: options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`),
                navigationButton: options.searchNavigationButtonStyle ?? ((text) => text),
            },
        );
        this.selection = new TextSelection({
            ...host,
            previousScreen: () => this.previousScreen,
            copyOnSelect: () => this.copyOnSelect,
            copy: (text) => this.copyTextToClipboard(text),
            onClick: (x, y) => this.onClick?.(x, y),
            openUrl: options.openUrl,
        });
        this.viewportKeys = viewportKeyActions({
            viewportHeight: () => this.getPrimaryScrollView().viewportHeight,
            scrollBy: (lines) => this.scrollBy(lines),
            scrollToPrompt: (direction) => this.scrollToPrompt(direction),
            scrollToTop: () => this.scrollToTop(),
            scrollToBottom: () => this.scrollToBottom(),
        });
        this.addInputListener((data) => this.handleViewportInput(data));
    }

    private viewportHost(): ViewportHost {
        const screen = this;
        return {
            get terminal() {
                return screen.terminal;
            },
            layout: () => this.currentLayout,
            primaryScrollView: (layout) =>
                layout ? (layout.primaryScrollView ?? this.implicitScrollView) : this.getPrimaryScrollView(),
            hasOverlay: () => this.hasOverlay(),
            requestRender: () => this.requestRender(),
        };
    }

    // ---- public API ----

    get viewportTop(): number {
        return this.getPrimaryScrollView().scrollTop;
    }

    get isFollowingOutput(): boolean {
        return this.getPrimaryScrollView().isFollowingEnd;
    }

    /**
     * Rows between the end of the frame's content and the bottom of the
     * screen, as drawn last frame. Zero when the content reaches the last
     * row; positive when the document is shorter than the screen; NEGATIVE
     * when the document is scrolled back and its end is below the screen by
     * that many rows. Anything anchored to the end of the document (a menu
     * on the prompt) is anchored to this, not to `getContentHeight()`, which
     * knows the document's length but not where the window onto it sits.
     *
     * With a layout root the author owns the whole viewport and the frame
     * fills it by construction, so this is always zero.
     */
    get rowsBelowContent(): number {
        if (this.layoutRoot) return 0;
        return this.terminal.rows - (this.contentHeight - this.implicitScrollView.scrollTop);
    }

    setWheelScrollLines(lines: WheelScrollLines): void {
        this.wheelScroll.setLines(lines);
    }

    getCopyOnSelect(): boolean {
        return this.copyOnSelect;
    }

    setCopyOnSelect(enabled: boolean): void {
        this.copyOnSelect = enabled;
    }

    /** Whether the fullscreen viewport has a non-empty active text selection. */
    hasActiveSelection(): boolean {
        return this.selection.text() !== undefined;
    }

    /** Copy the active fullscreen text selection, if any, using the configured selection clipboard path. */
    async copyActiveSelectionToClipboard(): Promise<boolean> {
        const text = this.selection.text();
        if (!text) return false;
        return this.copyTextToClipboard(text);
    }

    /** See {@link mouseInterceptor}. Pass undefined to remove it. */
    setMouseInterceptor(
        fn: ((event: { button: number; x: number; y: number; release: boolean }) => boolean) | undefined,
    ): void {
        this.mouseInterceptor = fn;
    }

    setLayoutRoot(component: Component | undefined): void {
        if (this.layoutRoot === component) return;
        this.layoutRoot = component;
        this.currentLayout = undefined;
        this.requestRender();
    }

    override render(width: number): string[] {
        return this.layoutRoot?.render(width) ?? super.render(width);
    }

    scrollBy(lines: number): void {
        this.getPrimaryScrollView().scrollBy(lines);
        this.requestRender();
    }

    scrollToTop(): void {
        this.getPrimaryScrollView().scrollToStart();
        this.requestRender();
    }

    /** A keyboard-driven jump to the end: the End key, or the app revealing
     * the prompt on a keystroke. The wheel yields to it for a moment. */
    scrollToBottom(): void {
        this.getPrimaryScrollView().scrollToEnd();
        this.wheelHoldUntil = Date.now() + WHEEL_YIELDS_TO_KEYBOARD_MS;
        this.requestRender();
    }

    /** Show a transient message in the alternate-screen flash stack. */
    flash(message: string, durationMs?: number): void {
        this.flashes.flash(message, durationMs);
    }

    // ---- lifecycle ----

    protected override getMountedRoots(): readonly Component[] {
        return this.layoutRoot ? [this.layoutRoot] : this.children;
    }

    private getPrimaryScrollView(): ScrollView {
        return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
    }

    /** End every pointer gesture in progress. */
    private stopGestures(): void {
        this.selection.cancelPress();
        this.scrollbar.stopHover();
        this.scrollbar.stopDrag();
        this.flashes.dispose();
    }

    protected override beforeTerminalStart(): void {
        this.stopGestures();
        this.altScreenActive = true;
        const capabilities = getCapabilities();
        this.imageProtocol = capabilities.images;
        this.kittyCache.clear();
        if (capabilities.images === "iterm2") {
            this.savedCapabilities = capabilities;
            setCapabilities({ ...capabilities, images: null });
            this.invalidate();
        }
        this.selection.reset();
        this.resetRenderState();
        this.mouseSequence = mouseTrackingSequence();
        this.terminal.write(
            `${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? this.mouseSequence : ""}\x1b[2J\x1b[H${HIDE_CURSOR}`,
        );
    }

    /**
     * LOCAL CHANGE (keep across pi-mono syncs).
     *
     * loop's Terminal.start() cleanses stale modes before it hands over —
     * including `?1000l ?1006l` — because a predecessor killed with SIGKILL
     * never ran its exit handlers and leaves the shell echoing raw key
     * reports. That cleanse runs AFTER beforeTerminalStart, so the mouse
     * tracking the alternate screen just asked for is switched straight back
     * off and the wheel stops reaching the transcript. There is no terminal
     * scrollback to fall back on here, so that is the whole of scrolling.
     *
     * Re-asserted rather than reordered: the cleanse has to run late (it is
     * clearing someone else's mess), and these sequences are idempotent.
     */
    protected override afterTerminalStart(): void {
        if (!this.mouseEnabled || !this.mouseSequence) return;
        this.terminal.write(this.mouseSequence);
    }

    protected override beforeTerminalStop(_options: TuiStopOptions): void {
        this.search.close();
        this.stopGestures();
        if (!this.altScreenActive) return;
        this.terminal.write(
            `${SYNC_BEGIN}${deleteAllImagesFor(this.imageProtocol)}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${SYNC_END}`,
        );
        this.kittyCache.clear();
    }

    protected override afterTerminalStop(options: TuiStopOptions): void {
        if (!this.altScreenActive) return;
        this.altScreenActive = false;
        if (options.preserveScreen) {
            this.terminal.write(`${SYNC_BEGIN}${EXIT_ALT_SCREEN}${SHOW_CURSOR}${SYNC_END}`);
        } else {
            this.terminal.write(this.exitWithTranscript());
        }
        if (this.savedCapabilities) {
            setCapabilities(this.savedCapabilities);
            this.savedCapabilities = undefined;
        }
    }

    /** Leave the alt screen and print the transcript into the normal screen. */
    private exitWithTranscript(): string {
        const lastDocument = this.exitDocument(Math.max(1, this.terminal.columns));
        const rows = lastDocument.map((line, row) => `${row > 0 ? "\r\n" : ""}\r${CLEAR_LINE}${line}`).join("");
        return `${SYNC_BEGIN}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}${rows}\x1b[0m${ENABLE_AUTOWRAP}\r\n${SHOW_CURSOR}${SYNC_END}`;
    }

    /**
     * loop-local: the transcript to leave in the terminal on the way out — or
     * none, if it cannot be drawn.
     *
     * Leaving the alt screen has to restore the terminal whatever the
     * components do. This render used to run bare, so a component that threw
     * took the exit down with it: no transcript, and a terminal left in the
     * alternate screen with autowrap off. A failure now costs only the print,
     * logged once like any other failed frame.
     */
    private exitDocument(width: number): string[] {
        try {
            const documentLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
            return this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map((line) =>
                fitToWidth(line, width),
            );
        } catch (error) {
            logRenderError("exit print", error, this.logDirectory);
            return [];
        }
    }

    protected override resetRenderState(): void {
        this.previousScreen = [];
        this.previousScreenWidth = 0;
        this.previousScreenHeight = 0;
        this.currentLayout = undefined;
    }

    protected override handleTerminalResize(): void {
        // A shrink can discard or shift terminal rows even if another resize
        // restores the old dimensions before the next frame. The cached screen
        // is no longer a safe diff baseline. Keep layout and scroll state so
        // input arriving before the repaint still targets the current view.
        this.previousScreen = [];
        this.requestRender();
    }

    // ---- input ----

    private handleViewportInput(data: string): InputResult {
        if (data === FOCUS_OUT) {
            this.handleFocusLost();
            return CONSUMED;
        }
        if (data === FOCUS_IN) {
            this.onFocusIn?.();
            return CONSUMED;
        }
        const wheel = parseWheelEvent(data);
        if (wheel) return this.handleWheel(wheel);
        const mouse = parseSgrMouseEvent(data);
        if (mouse) {
            this.handleMouse(mouse);
            return CONSUMED;
        }
        if (isMouseSequence(data)) return CONSUMED;
        return this.handleViewportKey(data);
    }

    private handleFocusLost(): void {
        this.selection.onFocusLost();
        this.scrollbar.stopHover();
        this.search.clearHover();
        this.scrollbar.stopDrag();
    }

    /** Keys go to a focused overlay (other than the search bar) rather than the viewport. */
    private shouldDeferViewportInputToOverlay(): boolean {
        return this.isOverlayFocused() && !this.search.isFocused;
    }

    private handleWheel(event: WheelEvent): InputResult {
        if (this.shouldDeferViewportInputToOverlay()) return undefined;
        // The wheel tail's up-events, inside the hold, are not the user.
        const yielding = event.direction < 0 && Date.now() < this.wheelHoldUntil;
        if (!yielding) {
            const lines = this.wheelScroll.next(event.direction, performance.now());
            this.routeWheel(event, event.direction * (hasAlt(event) ? lines * ALT_WHEEL_SCROLL_MULTIPLIER : lines));
        }
        return CONSUMED;
    }

    /** Scroll the innermost scroll view under the pointer, passing what it can't take outward. */
    private routeWheel(event: WheelEvent, delta: number): void {
        let remaining = delta;
        const seen = new Set<ScrollView>();
        for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
            seen.add(scrollView);
            remaining = scrollView.scrollBy(remaining);
            if (remaining === 0 || scrollView.overscroll === "contain") break;
        }
        const primary = this.getPrimaryScrollView();
        if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
        this.scrollbar.updateHover(event.x, event.y);
        this.requestRender();
    }

    /** First taker wins: an interceptor, right-click paste, the search bar, the jump-to-end label, the scrollbar, then selection. */
    private handleMouse(event: SgrMouseEvent): void {
        if (this.mouseInterceptor?.(event)) return;
        if (this.handleRightClickPaste(event)) return;
        if (this.search.handleMouse(event)) return;
        if (this.handleScrollToEndIndicatorClick(event)) return;
        const handled = this.scrollbar.handleMouse(event, () => this.selection.reset());
        if (!this.scrollbar.isDragging) this.scrollbar.updateHover(event.x, event.y);
        if (!handled) this.selection.handleMouse(event);
    }

    private handleRightClickPaste(event: SgrMouseEvent): boolean {
        if (
            !this.onRightClickPaste ||
            process.platform !== "win32" ||
            process.env.TERM_PROGRAM?.toLowerCase() === "vscode" ||
            event.release ||
            event.button !== 2
        ) {
            return false;
        }
        try {
            this.onRightClickPaste();
        } catch {
            // Clipboard paste is best-effort.
        }
        return true;
    }

    private handleScrollToEndIndicatorClick(event: SgrMouseEvent): boolean {
        const rect = this.scrollToEndIndicatorRect;
        if (!rect || !isPrimaryPress(event)) return false;
        if (event.y !== rect.row || event.x < rect.column || event.x >= rect.column + rect.width) return false;
        this.scrollToBottom();
        return true;
    }

    private handleViewportKey(data: string): InputResult {
        const keybindings = getKeybindings();
        const isRelease = isKeyRelease(data);
        // A key typed inside the wheel hold keeps it going; one typed outside starts nothing.
        const now = Date.now();
        if (!isRelease && now < this.wheelHoldUntil) this.wheelHoldUntil = now + WHEEL_YIELDS_TO_KEYBOARD_MS;

        const run = (action: () => void): InputResult => {
            if (!isRelease) action();
            return CONSUMED;
        };
        if (keybindings.matches(data, "tui.altScreen.search")) return run(() => this.search.toggle());
        if (this.search.isFocused) {
            if (keybindings.matches(data, "tui.altScreen.searchNext")) return run(() => this.search.navigate(1));
            if (keybindings.matches(data, "tui.altScreen.searchPrevious")) return run(() => this.search.navigate(-1));
            if (keybindings.matches(data, "tui.altScreen.searchClose")) return run(() => this.search.close());
        }
        if (this.shouldDeferViewportInputToOverlay()) return undefined;
        const action = this.viewportKeys.find(([binding]) => keybindings.matches(data, binding));
        return action ? run(action[1]) : undefined;
    }

    /** Jump to the previous or next shell prompt (an OSC 133 prompt-start mark) in the transcript. */
    private scrollToPrompt(direction: -1 | 1): void {
        if (!this.currentLayout) return;
        const scrollView = this.getPrimaryScrollView();
        const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
        if (!lines) return;
        for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
            if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
            scrollView.scrollTo(row);
            this.requestRender();
            return;
        }
    }

    private async copyTextToClipboard(text: string): Promise<boolean> {
        // Prefer an injected clipboard implementation (native clipboard + platform tools with a
        // verified success path) when the host app provides one. A bare OSC 52 write can show
        // "Copied!" while leaving the system clipboard untouched (e.g. macOS Terminal.app, tmux
        // without OSC 52 clipboard passthrough), so only report success when it actually copies.
        if (this.copySelection) {
            const ok = await this.copySelection(text);
            this.flash(ok ? "Copied!" : "Copy failed");
            return ok;
        }
        this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
        this.flash("Copied!");
        return true;
    }

    // ---- rendering ----

    protected override doRender(): void {
        if (this.stopped || !this.altScreenActive) return;
        const width = Math.max(1, this.terminal.columns);
        const height = Math.max(1, this.terminal.rows);
        const layout = this.layOut(width, height);
        const screen = this.composeScreen(layout, width, height);
        const cursorPos = this.extractCursorPosition(screen, height);
        const finalScreen = this.applyLineResets(screen).map((line) => fitToWidth(line, width));

        const update = buildScreenUpdate({
            screen: finalScreen,
            previousScreen: this.previousScreen,
            previousSize: { width: this.previousScreenWidth, height: this.previousScreenHeight },
            width,
            height,
            cursorPos,
            showHardwareCursor: this.getShowHardwareCursor(),
            imageProtocol: this.imageProtocol,
            kittyCache: this.kittyCache,
        });
        if (update.fullRedraw) this.fullRedrawCount += 1;
        this.terminal.write(update.output);

        this.previousScreen = finalScreen;
        this.previousScreenWidth = width;
        this.previousScreenHeight = height;
        this.currentLayout = layout;
    }

    /** Lay the frame out; again if refreshing the search scrolled to a match. */
    private layOut(width: number, height: number): LayoutFrame {
        const root = this.layoutRoot ?? this.implicitScrollView;
        this.frameId++;
        this.renderingFrame = true;
        let layout: LayoutFrame;
        try {
            layout = renderLayoutFrame(root, width, height, () => this.requestRender());
            if (this.search.refresh(layout)) {
                layout = renderLayoutFrame(root, width, height, () => this.requestRender());
            }
        } finally {
            this.renderingFrame = false;
        }
        // Where the frame's CONTENT ends, which is what an overlay anchored to
        // the bottom of the frame needs. With a layout root the author owns the
        // whole viewport and the frame fills it by construction. Without one,
        // the implicit document can be shorter than the viewport the layout
        // pads it out to — and reporting the padded height there puts every
        // overlay one row too low, over the status rows.
        this.contentHeight = this.layoutRoot ? layout.lines.length : this.implicitScrollView.getContentHeight();
        return layout;
    }

    /** Everything drawn over the laid-out lines, in stacking order. */
    private composeScreen(layout: LayoutFrame, width: number, height: number): string[] {
        let screen = layout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
        screen = this.search.highlight(screen, layout);
        const indicator = compositeScrollToEndIndicator(
            screen,
            layout,
            layout.primaryScrollView ?? this.implicitScrollView,
            this.scrollToEndIndicator,
            width,
        );
        this.scrollToEndIndicatorRect = indicator.rect;
        screen = this.compositeOverlays(indicator.screen, width, height);
        if (screen.length > height) screen = screen.slice(screen.length - height);
        screen = this.selection.apply(screen, layout);
        return compositeFlashes(screen, this.flashes.render(width), width, height);
    }
}

/** Cut a text line down to the terminal width; image lines are left alone. */
function fitToWidth(line: string, width: number): string {
    return isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true);
}
