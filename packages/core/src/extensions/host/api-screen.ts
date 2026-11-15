/**
 * The parts of the extension API that put things on the interactive screen or
 * spawn live processes: widgets, docks, key bindings, terminals. Each live
 * thing is recorded on the extension's contributions so unload can take it down.
 */
import type {
    DockHandle,
    DockOptions,
    ExtensionAPI,
    TerminalHandle,
    TerminalSpawnOptions,
    WidgetHandle,
    WidgetOptions,
    WidgetRenderer,
} from "../api";
import type { ApiContext } from "./api-context";

export function widgetsApi(ctx: ApiContext): ExtensionAPI["widgets"] {
    return {
        show: (renderer: WidgetRenderer, options?: WidgetOptions): WidgetHandle | undefined => {
            const services = ctx.services();
            if (services.widgets) {
                const handle = services.widgets.show(renderer, options);
                ctx.contributions.widgets.push(handle);
                return handle;
            }
            // Interactive but not yet on screen: hand back a handle that
            // records what the script does and replays it at flush time.
            // Print mode has no interactive layer at all, so there is
            // nothing to wait for and nothing to return.
            if (!services.interactive) return undefined;
            const handle = ctx.pendingUi.queueWidget(renderer, options);
            ctx.contributions.widgets.push(handle);
            return handle;
        },
    };
}

export function docksApi(ctx: ApiContext): ExtensionAPI["docks"] {
    return {
        open: (renderer: WidgetRenderer, options?: DockOptions): DockHandle | undefined => {
            // No queueing here, unlike widgets: a dock changes the
            // frame's layout, and replaying that against a screen built
            // later is a worse failure than simply not having one during
            // activation. Scripts open docks from a key or a command.
            const handle = ctx.services().docks?.open(renderer, options);
            if (handle) ctx.contributions.docks.push(handle);
            return handle;
        },
    };
}

export function keymapApi(ctx: ApiContext): ExtensionAPI["keymap"] {
    return {
        set: (key: string, handler: () => boolean | void): (() => void) => {
            const services = ctx.services();
            if (services.keymap) {
                const dispose = services.keymap.set(key, handler);
                ctx.contributions.keymapDisposers.push(dispose);
                return dispose;
            }
            if (!services.interactive) return () => {};
            const dispose = ctx.pendingUi.queueKeymap(key, handler);
            ctx.contributions.keymapDisposers.push(dispose);
            return dispose;
        },
    };
}

export function terminalApi(ctx: ApiContext): ExtensionAPI["terminal"] {
    return {
        available: async (): Promise<boolean> => {
            try {
                const { ptyAvailable } = await import("../../terminal/session");
                return ptyAvailable();
            } catch {
                return false;
            }
        },
        spawn: async (options?: TerminalSpawnOptions): Promise<TerminalHandle> => {
            // Loaded here rather than at module scope: the emulator is
            // megabytes a session that never opens a terminal should not
            // pay for.
            const { createTerminalSession } = await import("../../terminal/session");
            const session = createTerminalSession(options) as TerminalHandle;
            ctx.contributions.terminals.push(session);
            return session;
        },
    };
}
