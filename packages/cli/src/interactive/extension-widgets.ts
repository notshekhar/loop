/**
 * The TUI half of `api.widgets` and `api.keymap`.
 *
 * Core can't import the TUI, so it declares the shapes (WidgetRenderer /
 * WidgetOptions / WidgetHandle in extensions/api.ts) and the interactive app
 * injects this implementation through `setServices`. Print mode injects
 * nothing, which is what makes `api.widgets.show` return undefined there.
 *
 * A widget renderer is structurally the TUI's `Component` minus `invalidate`,
 * so the adapter is mostly a matter of not letting a thrown render take the
 * frame down with it.
 */
import type {
    DockHandle,
    DockOptions,
    WidgetHandle,
    WidgetMouseEvent,
    WidgetOptions,
    WidgetRenderer,
} from "@notshekhar/loop-core";
import {
    isKeyRelease,
    isKeyRepeat,
    matchesKey,
    VStack,
    type Component,
    type KeyId,
    type OverlayOptions,
    type TUI,
} from "@notshekhar/loop-tui";

/**
 * Wrap an extension's renderer as a TUI component.
 *
 * Every call into extension code is guarded: `render` runs on every frame and a
 * throw there would tear down the whole paint, not just the widget. A widget
 * that fails renders as a one-line error instead — visible, but survivable, and
 * the same bargain status-line contributors already get.
 */
function toComponent(renderer: WidgetRenderer, onError: (err: unknown) => void) {
    let failed = false;
    return {
        render(width: number): string[] {
            try {
                const lines = renderer.render(width);
                failed = false;
                return Array.isArray(lines) ? lines : [];
            } catch (err) {
                if (!failed) onError(err); // report once, not once per frame
                failed = true;
                return [`[widget error: ${(err as Error).message ?? String(err)}]`];
            }
        },
        handleInput(data: string): void {
            try {
                renderer.handleInput?.(data);
            } catch (err) {
                onError(err);
            }
        },
        invalidate(): void {},
    };
}

/** Percentages arrive as strings ("50%"); the TUI accepts both forms. */
function sizeValue(value: number | string | undefined): OverlayOptions["width"] {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value)) return value as `${number}%`;
    return undefined;
}

function toOverlayOptions(options: WidgetOptions | undefined): OverlayOptions {
    if (!options) return {};
    return {
        anchor: options.anchor as OverlayOptions["anchor"],
        width: sizeValue(options.width),
        minWidth: options.minWidth,
        maxHeight: sizeValue(options.maxHeight),
        offsetX: options.offsetX,
        offsetY: options.offsetY,
        row: sizeValue(options.row),
        col: sizeValue(options.col),
        nonCapturing: options.nonCapturing,
    };
}

/**
 * `getFocusedComponent` exists on the TUI class but not on the exported `TUI`
 * interface. packages/tui is a light fork kept close to pi-mono, so widening
 * that interface would be a divergence to re-merge on every sync; selectors.ts
 * reaches for `addInputListener` the same way.
 */
type TuiWithFocus = TUI & {
    getFocusedComponent?(): Component | null;
    getOverlayRect?(component: Component): { row: number; col: number; width: number; height: number } | undefined;
    setMouseInterceptor?(
        fn: ((event: { button: number; x: number; y: number; release: boolean }) => boolean) | undefined,
    ): void;
    hitTestOverlay?(
        x: number,
        y: number,
    ): { component: Component; rect: { row: number; col: number }; localX: number; localY: number } | undefined;
};

/** Bit flags packed into the SGR button field. */
const MOUSE_MOTION = 32;
const MOUSE_WHEEL = 64;
const MOUSE_SHIFT = 4;
const MOUSE_ALT = 8;
const MOUSE_CTRL = 16;

interface ParsedMouse {
    button: number;
    /** 0-based screen coordinates. */
    x: number;
    y: number;
    type: WidgetMouseEvent["type"];
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
}

/**
 * Decode the alt screen's SGR event into the shape widgets see: 0-based
 * coordinates, and the button field unpacked into a type and modifiers.
 */
function normalizeMouse(raw: { button: number; x: number; y: number; release: boolean }): ParsedMouse | undefined {
    if ((raw.button & MOUSE_WHEEL) !== 0) return undefined;
    const motion = (raw.button & MOUSE_MOTION) !== 0;
    const button = raw.button & 3;
    return {
        button,
        x: raw.x - 1,
        y: raw.y - 1,
        type: raw.release ? "release" : motion ? (button === 3 ? "move" : "drag") : "press",
        shift: (raw.button & MOUSE_SHIFT) !== 0,
        alt: (raw.button & MOUSE_ALT) !== 0,
        ctrl: (raw.button & MOUSE_CTRL) !== 0,
    };
}

export interface ExtensionUiServices {
    screen: () => { rows: number; cols: number };
    widgets: { show(renderer: WidgetRenderer, options?: WidgetOptions): WidgetHandle };
    docks: { open(renderer: WidgetRenderer, options?: DockOptions): DockHandle };
    keymap: { set(key: string, handler: () => boolean | void): () => void };
}

/**
 * Pads or clips a renderer to an exact row count.
 *
 * A dock occupies a fixed band of the frame, so its height must not depend on
 * what the script happened to return this frame — a panel that grew a line
 * would push the transcript around on every repaint. Content longer than the
 * band is clipped from the bottom; shorter is padded with blanks.
 */
function fixedHeight(component: Component, height: () => number): Component {
    return {
        render(width: number): string[] {
            const rows = Math.max(0, height());
            if (rows === 0) return [];
            const lines = component.render(width).slice(0, rows);
            while (lines.length < rows) lines.push("");
            return lines;
        },
        handleInput(data: string): void {
            component.handleInput?.(data);
        },
        invalidate(): void {
            component.invalidate?.();
        },
    };
}

/**
 * @param dockHost the (initially empty) stack sitting between the transcript
 * and the input box. An empty stack renders zero rows, so it costs the frame
 * nothing until something is docked.
 */
/**
 * Control over the pinned frame, which docks require.
 *
 * The dock host only participates in the layout when the pinned frame is the
 * layout root, and pinned input is off by default — so without this a script
 * would open a dock and simply get nothing, with no error to explain it. The
 * first dock turns the frame on and the last one puts it back, which is fair
 * because a docked panel is a pinned layout by definition. Only the live mode
 * is changed; the user's saved `pinnedInput` setting is never written.
 */
export interface FrameControl {
    isPinned(): boolean;
    setPinned(on: boolean): void;
    /** Hand the keyboard back to the prompt when a panel gives it up. */
    focusEditor(): void;
}

/**
 * Every dock currently mounted, so the exit path can take them down before the
 * final frame is painted (see `closeExtensionDocks`).
 */
const openDocks = new Set<() => void>();

/** The pinned mode from before the first dock opened, to restore on the last close. */
let pinnedBeforeDocks: boolean | undefined;

/**
 * Close every dock. Called on the way out, before the TUI paints its last
 * frame — a dock still in the layout would otherwise be printed into the
 * scrollback and stay there.
 */
export function closeExtensionDocks(): void {
    for (const close of [...openDocks]) {
        try {
            close();
        } catch {
            // A dock the extension already closed is still closed.
        }
    }
    openDocks.clear();
    pinnedBeforeDocks = undefined;
}

export function createExtensionUiServices(
    tui: TUI,
    dockHost: VStack,
    frame: FrameControl,
    onError: (err: unknown) => void,
): ExtensionUiServices {
    /** Widgets that can take mouse events, keyed by the component the TUI knows. */
    const mouseTargets = new Map<Component, WidgetRenderer>();

    /**
     * Keys bound through `api.keymap`, so a focused panel can let them through.
     * Without this a terminal panel swallows its own toggle and there is no way
     * out of it but quitting loop.
     */
    const boundKeys = new Set<string>();

    /** Docks that want raw keyboard input, by the component the TUI focuses. */
    const keyboardDocks = new Map<Component, WidgetRenderer>();

    /**
     * Feed the focused dock before anything else looks at the key.
     *
     * A dock cannot rely on the TUI's focused-component dispatch: the app's own
     * input handler is itself an input listener (see app.ts), and listeners all
     * run before the focused component — so ctrl+c would ask loop to quit
     * instead of interrupting the shell in the panel. This listener is
     * registered while the services are built, which is before that handler,
     * so a focused panel really does get first refusal on every key.
     *
     * Two things are deliberately let through: keys bound with `api.keymap`
     * (the panel's own toggle is how the user gets out) and Kitty key-release
     * reports, which are not input.
     */
    tui.addInputListener((data: string) => {
        if (keyboardDocks.size === 0) return undefined;
        const focused = (tui as TuiWithFocus).getFocusedComponent?.();
        if (!focused) return undefined;
        const renderer = keyboardDocks.get(focused);
        if (!renderer?.handleInput) return undefined;
        if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
        for (const key of boundKeys) {
            if (matchesKey(data, key as KeyId)) return undefined;
        }
        try {
            renderer.handleInput(data);
        } catch (err) {
            onError(err);
        }
        tui.requestRender();
        return { consume: true };
    });

    /**
     * Route mouse events to widgets.
     *
     * This is installed as the alt screen's mouse interceptor rather than a
     * plain input listener, because the viewport registers its own listener in
     * its constructor — ahead of anything added later — and consumes every
     * mouse event for selection and scrollbars. The interceptor sits at the
     * front of that chain instead, so consuming an event here suppresses text
     * selection, scrollbar drags and link clicks for that event, and declining
     * leaves all of them working exactly as before.
     *
     * A drag keeps going to the widget that was pressed even once the pointer
     * leaves it, which is what dragging a box by its edge requires.
     */
    let dragTarget: { component: Component; renderer: WidgetRenderer } | undefined;

    const withMouse = tui as TuiWithFocus;
    withMouse.setMouseInterceptor?.((raw) => {
        if (mouseTargets.size === 0 && !dragTarget) return false;
        const event = normalizeMouse(raw);
        // Wheel events are scrolling, not pointing — they stay with the viewport.
        if (!event) return false;

        let target = dragTarget;
        let local = { x: 0, y: 0 };
        if (target) {
            const rect = withMouse.getOverlayRect?.(target.component);
            local = rect ? { x: event.x - rect.col, y: event.y - rect.row } : { x: event.x, y: event.y };
        } else {
            const hit = withMouse.hitTestOverlay?.(event.x, event.y);
            const renderer = hit ? mouseTargets.get(hit.component) : undefined;
            if (!hit || !renderer) return false;
            target = { component: hit.component, renderer };
            local = { x: hit.localX, y: hit.localY };
        }

        if (!target.renderer.handleMouse) return false;
        let consumed = false;
        try {
            consumed =
                target.renderer.handleMouse({
                    type: event.type,
                    button: event.button,
                    x: local.x,
                    y: local.y,
                    screenX: event.x,
                    screenY: event.y,
                    shift: event.shift,
                    alt: event.alt,
                    ctrl: event.ctrl,
                }) === true;
        } catch (err) {
            onError(err);
        }

        // Track the press so the motion that follows reaches the same widget,
        // and release unconditionally — a drag that outlived its widget would
        // swallow every later click.
        if (consumed && event.type === "press") dragTarget = target;
        if (event.type === "release") dragTarget = undefined;

        if (!consumed) return false;
        tui.requestRender();
        return true;
    });

    return {
        screen: () => ({ rows: tui.terminal.rows, cols: tui.terminal.columns }),
        widgets: {
            show(renderer, options) {
                // Held rather than passed and forgotten: the TUI re-reads an
                // overlay's options on every composite, so mutating this object
                // is how a widget moves — which is what makes dragging possible
                // without the TUI needing to know anything about it.
                const overlayOptions = toOverlayOptions(options);
                const component = toComponent(renderer, onError);
                const overlay = tui.showOverlay(component, overlayOptions);
                mouseTargets.set(component, renderer);
                tui.requestRender();
                return {
                    setPosition: (row: number, col: number) => {
                        // Absolute row/col override anchor-based placement, so
                        // clear the anchor's offsets to avoid fighting them.
                        overlayOptions.row = Math.max(0, Math.floor(row));
                        overlayOptions.col = Math.max(0, Math.floor(col));
                        overlayOptions.offsetX = undefined;
                        overlayOptions.offsetY = undefined;
                        tui.requestRender();
                    },
                    getPosition: () => {
                        const rect = (tui as TuiWithFocus).getOverlayRect?.(component);
                        return rect ? { row: rect.row, col: rect.col } : undefined;
                    },
                    hide: () => {
                        mouseTargets.delete(component);
                        overlay.hide();
                        tui.requestRender();
                    },
                    setHidden: (hidden: boolean) => {
                        overlay.setHidden(hidden);
                        tui.requestRender();
                    },
                    isHidden: () => overlay.isHidden(),
                    focus: () => {
                        overlay.focus();
                        tui.requestRender();
                    },
                    unfocus: () => {
                        overlay.unfocus();
                        tui.requestRender();
                    },
                };
            },
        },

        docks: {
            open(renderer, options) {
                let size = Math.max(1, options?.size ?? 10);
                let open = true;
                const inner = toComponent(renderer, onError);
                const component = fixedHeight(inner, () => (open ? size : 0));
                if (renderer.handleInput) keyboardDocks.set(component, renderer);
                // shrink: 0 so the panel keeps its height and the transcript
                // (grow: 1) is what gives up the rows, which is the whole point.
                if (openDocks.size === 0) {
                    pinnedBeforeDocks = frame.isPinned();
                    if (!pinnedBeforeDocks) frame.setPinned(true);
                }
                dockHost.addChild(component, { shrink: 0 });
                tui.requestRender();

                const close = (): void => {
                    if (!open) return;
                    open = false;
                    openDocks.delete(close);
                    keyboardDocks.delete(component);
                    if ((tui as TuiWithFocus).getFocusedComponent?.() === component) frame.focusEditor();
                    dockHost.removeChild(component);
                    if (openDocks.size === 0 && pinnedBeforeDocks === false) {
                        frame.setPinned(false);
                        pinnedBeforeDocks = undefined;
                    }
                    tui.requestRender();
                };
                openDocks.add(close);
                return {
                    close,
                    setSize: (rows: number) => {
                        size = Math.max(1, rows);
                        tui.requestRender();
                    },
                    isOpen: () => open,
                    focus: () => {
                        if (!open) return;
                        tui.setFocus(component);
                        tui.requestRender();
                    },
                    unfocus: () => {
                        if ((tui as TuiWithFocus).getFocusedComponent?.() === component) frame.focusEditor();
                        tui.requestRender();
                    },
                    isFocused: () => (tui as TuiWithFocus).getFocusedComponent?.() === component,
                };
            },
        },

        keymap: {
            /**
             * Bindings ride the TUI's input listeners rather than the keybinding
             * registry: that registry is built once at startup
             * (registerAppKeybindings), so it cannot take entries from an
             * extension that loads later or is reloaded mid-session.
             *
             * A listener sees the key before the editor does, so a binding wins
             * over typing — deliberate, since that is what a global shortcut is.
             * Only an exact match is consumed; every other key passes through
             * untouched, which keeps a stray binding from swallowing input.
             */
            set(key, handler) {
                boundKeys.add(key);
                const dispose = tui.addInputListener((data: string) => {
                    if (!matchesKey(data, key as KeyId)) return undefined;
                    // Under the Kitty protocol a terminal reports press, repeat
                    // AND release for the same key, and an input listener runs
                    // ahead of the filtering that normally drops the last two.
                    // Without this a binding fires twice per keypress — a toggle
                    // turns on and straight back off, so the thing it opens is
                    // only visible while the key is held. Holding the key should
                    // not re-fire it either, hence repeats go too.
                    if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
                    try {
                        const consumed = handler();
                        tui.requestRender();
                        return consumed === false ? undefined : { consume: true };
                    } catch (err) {
                        onError(err);
                        return { consume: true };
                    }
                });
                return () => {
                    boundKeys.delete(key);
                    dispose();
                };
            },
        },
    };
}
