/**
 * The CLI-injected services the host can't implement itself, and the queue that
 * holds widget/key-binding requests made before those services exist.
 */
import type { DockHandle, DockOptions, ExtensionUI, WidgetHandle, WidgetOptions, WidgetRenderer } from "../api";

/**
 * UI/browser capabilities the host can't implement itself — they live in the
 * CLI/TUI layer, which core cannot import. The CLI injects them via
 * `setServices` before `init()`. Absent in headless/print mode, where `ui` is
 * undefined (so `api.ui` throws) and `openExternal` is a no-op.
 */
export interface HostServices {
    ui?: ExtensionUI;
    openExternal?: (url: string) => void;
    /** Ask the interactive UI to repaint (e.g. a live status line). No-op in print mode. */
    requestRender?: () => void;
    /** Floating widgets. Absent outside interactive mode. */
    widgets?: { show(renderer: WidgetRenderer, options?: WidgetOptions): WidgetHandle };
    /** Terminal size in cells. Absent outside interactive mode. */
    screen?: () => { rows: number; cols: number };
    /** Docked panels. Absent outside interactive mode. */
    docks?: { open(renderer: WidgetRenderer, options?: DockOptions): DockHandle };
    /** Global key bindings. Absent outside interactive mode. */
    keymap?: { set(key: string, handler: () => boolean | void): () => void };
    /**
     * Set by the interactive app before `init()`, while the TUI does not exist
     * yet. It is what tells the host that a widget or key binding requested
     * during activation is worth queueing rather than discarding.
     */
    interactive?: boolean;
}

/** State a script set on a widget before the screen was ready to show it. */
interface PendingWidgetCell {
    cancelled: boolean;
    hidden: boolean;
    focused: boolean;
    position?: { row: number; col: number };
    handle?: WidgetHandle;
}

interface PendingKeymapCell {
    dispose?: () => void;
    cancelled: boolean;
}

/** A handle that stands in for a widget until the TUI can really show it. */
function pendingWidgetHandle(cell: PendingWidgetCell): WidgetHandle {
    return {
        hide: () => {
            cell.cancelled = true;
            cell.handle?.hide();
        },
        setPosition: (row: number, col: number) => {
            cell.position = { row, col };
            cell.handle?.setPosition(row, col);
        },
        getPosition: () => cell.handle?.getPosition() ?? cell.position,
        setHidden: (hidden: boolean) => {
            cell.hidden = hidden;
            cell.handle?.setHidden(hidden);
        },
        isHidden: () => cell.handle?.isHidden() ?? cell.hidden,
        focus: () => {
            cell.focused = true;
            cell.handle?.focus();
        },
        unfocus: () => {
            cell.focused = false;
            cell.handle?.unfocus();
        },
    };
}

/**
 * Widgets and key bindings asked for before the TUI existed.
 *
 * `init()` runs before the interactive app builds its TUI, so an extension
 * that binds a key or shows a widget from `activate` — which is exactly
 * where most extensions set themselves up — would otherwise get a silent no-op.
 * These queue instead, and `setServices` flushes them once the screen is
 * real. Print mode never provides the services, so the queue is simply
 * dropped, which is the correct outcome there.
 */
export class PendingUiQueue {
    private keymaps: { key: string; handler: () => boolean | void; cell: PendingKeymapCell }[] = [];
    private widgets: { renderer: WidgetRenderer; options?: WidgetOptions; cell: PendingWidgetCell }[] = [];

    /** Queue a widget and hand back a handle that records what the script does to it. */
    queueWidget(renderer: WidgetRenderer, options?: WidgetOptions): WidgetHandle {
        const cell: PendingWidgetCell = { cancelled: false, hidden: false, focused: false };
        this.widgets.push({ renderer, options, cell });
        return pendingWidgetHandle(cell);
    }

    /** Queue a key binding; the returned disposer works before and after the flush. */
    queueKeymap(key: string, handler: () => boolean | void): () => void {
        const cell: PendingKeymapCell = { cancelled: false };
        this.keymaps.push({ key, handler, cell });
        return (): void => {
            cell.cancelled = true;
            cell.dispose?.();
        };
    }

    /** Bind and show everything that was requested before the screen existed. */
    flush(services: HostServices): void {
        const keymap = services.keymap;
        if (keymap && this.keymaps.length > 0) {
            for (const pending of this.keymaps.splice(0)) {
                if (pending.cell.cancelled) continue;
                pending.cell.dispose = keymap.set(pending.key, pending.handler);
            }
        }
        const widgets = services.widgets;
        if (widgets && this.widgets.length > 0) {
            for (const pending of this.widgets.splice(0)) {
                if (pending.cell.cancelled) continue;
                const handle = widgets.show(pending.renderer, pending.options);
                pending.cell.handle = handle;
                // Replay the state the script set while it was still queued.
                if (pending.cell.hidden) handle.setHidden(true);
                if (pending.cell.focused) handle.focus();
                const at = pending.cell.position;
                if (at) handle.setPosition(at.row, at.col);
            }
        }
    }
}
