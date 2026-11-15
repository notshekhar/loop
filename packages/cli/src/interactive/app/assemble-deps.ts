/**
 * The app's own AppDeps: every handler, command and turn reaches the screen
 * and the session roster through this one object.
 */
import type { AppDeps } from "../deps";
import type { ScrollbackFocus } from "../scrollback-focus";
import { resolveModelId } from "./boot";
import { rosterOf, type AppCore } from "./context";
import type { Layout } from "./layout";
import type { Modals } from "./modals";
import type { Viewport } from "./viewport";

export interface ForegroundWorking {
    showWorking: (message?: string) => void;
    hideWorking: () => void;
}

/**
 * The loader shows the foreground session; the status bus reports the whole
 * pane, so it is working while ANY session is (see the roster listener).
 */
export function foregroundWorking(core: AppCore): ForegroundWorking {
    return {
        showWorking: (message) => rosterOf(core).showWorkingFor(core.slots.foreground, message),
        hideWorking: () => rosterOf(core).hideWorkingFor(core.slots.foreground),
    };
}

export interface DepsParts {
    layout: Layout;
    viewport: Viewport;
    modals: Modals;
    working: ForegroundWorking;
    refreshCommands: () => void;
    cleanExit: (code?: number) => void;
    restoreConsole: () => void;
    syncTicker: () => void;
    scrollbackFocus: ScrollbackFocus;
}

export function assembleAppDeps(core: AppCore, parts: DepsParts): AppDeps {
    const { tui, slots, state } = core;
    const { layout, viewport, modals, working } = parts;
    return {
        tui,
        history: core.history,
        statusLine: core.statusLine,
        todoPanel: core.todoPanel,
        shellsPanel: core.shellsPanel,
        tracker: core.tracker,
        editor: layout.editor,
        commands: core.commands,
        manager: core.manager,
        queuedMessages: core.queuedMessages,
        refreshStatusLine: core.statusLineRefresher.refreshStatusLine,
        refreshStatusLineCtx: core.statusLineRefresher.refreshStatusLineCtx,
        renderPending: layout.renderPending,
        showWorking: working.showWorking,
        hideWorking: working.hideWorking,
        showSelector: modals.showSelector,
        getSelectorDepth: modals.getSelectorDepth,
        selectOnce: modals.selectOnce,
        searchOnce: modals.searchOnce,
        toggleOnce: modals.toggleOnce,
        promptOnce: modals.promptOnce,
        resolveModelId: (input) => resolveModelId(input, state),
        ensureSession: () => rosterOf(core).ensureSessionFor(slots.foreground),
        sessions: {
            findLive: (idOrPath) =>
                slots.all().find((s) => s.session && (s.session.id === idOrPath || s.session.path === idOrPath)),
            switchTo: (slot) => slots.switchTo(slot),
            openNew: () => rosterOf(core).openNew(),
            showSwitcher: () => rosterOf(core).showSwitcher(),
            runningElsewhere: () => slots.all().filter((s) => s.busy && !slots.isForeground(s)).length,
        },
        isForeground: () => true,
        settleTurn: (failed) => slots.settle(slots.foreground, failed),
        cleanExit: parts.cleanExit,
        live: { feed: null },
        refreshCommands: parts.refreshCommands,
        version: core.opts.version,
        restoreConsole: parts.restoreConsole,
        syncTicker: parts.syncTicker,
        applyPinnedInput: layout.applyPinnedInput,
        transcriptViewport: viewport.transcriptViewport,
        revealPrompt: viewport.revealPrompt,
        scrollTranscriptToEnd: viewport.scrollTranscriptToEnd,
        revealSelection: viewport.revealSelection,
        scrollbackFocus: parts.scrollbackFocus,
    };
}
