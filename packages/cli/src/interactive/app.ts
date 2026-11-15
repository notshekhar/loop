/**
 * Interactive mode orchestrator: builds the TUI layout, wires state + deps
 * into the input handler / turn runner / command context, and kicks off
 * startup work. Behavior lives in the wired modules, not here; each step
 * lives in `app/`.
 */
import { initThemeFromSettings } from "./ui/theme";
import type { AskUserBridge } from "@notshekhar/loop-core";
import { createWorkingIndicator, type WorkingIndicator } from "./working-indicator";
import { createTicker } from "./ticker";
import { registerAppKeybindings } from "./app-keybindings";
import type { AppDeps } from "./deps";
import { createAppCore, loadCommands, openStartupSession } from "./app/boot";
import type { AppCore, InteractiveOptions } from "./app/context";
import { buildLayout, createAltScreenTui, type Layout } from "./app/layout";
import { createComposer, mountAutocompletePopup } from "./app/autocomplete";
import { attachScrollbackFocus, createViewport, type Viewport } from "./app/viewport";
import { attachPaneReporters } from "./app/reporters";
import { createModals } from "./app/modals";
import { exposeUiToExtensions, registerCoreBridges } from "./app/bridges";
import { installDiagnostics } from "./app/diagnostics";
import { createCleanExit } from "./app/exit";
import { assembleAppDeps, foregroundWorking, type ForegroundWorking } from "./app/assemble-deps";
import { showHookStatusOnLoader, wireSessions } from "./app/sessions";
import { announceStartup, showStartupBlock, startBackgroundWork, startScreen } from "./app/launch";

export type { InteractiveOptions } from "./app/context";

export async function runInteractive(opts: InteractiveOptions): Promise<void> {
    // A theme before anything can paint. Extensions may contribute one of
    // their own, so this runs again once the host is up (loadCommands) — it
    // is cheap, and the alternative is a first frame with no colours at all.
    initThemeFromSettings();
    registerAppKeybindings();

    const boot = await openStartupSession(opts);
    const commands = await loadCommands(opts.cwd);
    const core = createAppCore(opts, createAltScreenTui(), boot, commands);
    // The whole line, not just the context gauge: a session opened with
    // `--session` has cost, a context size and possibly a plan mode to
    // restore, and /resume (which restores all three) is the same session
    // arriving by a different door. The two were drifting apart one field at a
    // time.
    core.statusLineRefresher.refreshStatusLine();

    const { editor, refreshCommands } = createComposer(core);
    const layout = buildLayout(core, editor);
    const viewport = createViewport(core, layout);
    announceStartup(core);

    const { deps, askBridge, workingIndicator, working } = wireInteraction(core, layout, viewport, refreshCommands);
    await showStartupBlock(core, deps, boot.session);
    wireSessions(core, { deps, layout, workingIndicator, askBridge });
    showHookStatusOnLoader(core, working);

    startScreen(core, editor);
    startBackgroundWork(core, deps);
}

/**
 * Everything between the built screen and the live sessions: the loader,
 * the pane's watchers, menus and the bridges that open them, the ticker,
 * diagnostics, the exit path — assembled into the app's deps.
 */
function wireInteraction(
    core: AppCore,
    layout: Layout,
    viewport: Viewport,
    refreshCommands: () => void,
): { deps: AppDeps; askBridge: AskUserBridge; workingIndicator: WorkingIndicator; working: ForegroundWorking } {
    const { tui, state, statusLine } = core;
    const workingIndicator = createWorkingIndicator(tui, layout.statusContainer, layout.statusIdleSpacer);
    const working = foregroundWorking(core);
    const reporters = attachPaneReporters(core);
    mountAutocompletePopup(core, layout, viewport);
    const modals = createModals(core, layout, viewport, reporters.agentStatus);
    exposeUiToExtensions(core, layout, modals);
    const askBridge = registerCoreBridges(core, modals);

    // Shared 1s ticker (status line clock, /timer countdown, reminder scheduler);
    // owns its own timer/reminder/notice state and runs only while needed.
    const { syncTicker, stopTicker } = createTicker({
        state,
        statusLine,
        tui,
        getSelectorDepth: modals.getSelectorDepth,
        selectOnce: modals.selectOnce,
    });
    core.late.syncTicker = syncTicker;

    const restoreConsole = installDiagnostics(core);
    const cleanExit = createCleanExit(core, { stopTicker, hideWorking: working.hideWorking, reporters });
    const scrollbackFocus = attachScrollbackFocus(core, viewport);
    const deps = assembleAppDeps(core, {
        layout,
        viewport,
        modals,
        working,
        refreshCommands,
        cleanExit,
        restoreConsole,
        syncTicker,
        scrollbackFocus,
    });
    syncTicker();
    return { deps, askBridge, workingIndicator, working };
}
