/**
 * Things that go wrong, made visible in the chat: console output, frames
 * that failed to draw, the event tracer, and extensions that failed to load.
 */
import { envName, getExtensionHost, CONFIG_DIR_NAME } from "@notshekhar/loop-core";
import { installConsoleBridge } from "../console-bridge";
import { formatError } from "../format-error";
import { isEventTraceEnabled, setEventTraceSink, toggleEventTrace } from "../debug-log";
import { dim } from "../ui/text";
import type { AppCore } from "./context";

/** Returns the console bridge's undo, for handing the terminal to a child process. */
export function installDiagnostics(core: AppCore): () => void {
    const { tui, history } = core;
    const restoreConsole = installConsoleBridge(history, tui);
    // A frame that threw painted nothing. It is logged once with its stack
    // (render-error.log in the agent directory); say so once in the chat, so
    // a UI that recovers on the next frame also tells you it stumbled — and
    // where the evidence is.
    tui.onRenderError = (error) => {
        history.addError(`a frame failed to draw and was skipped: ${formatError(error)} (see render-error.log)`);
    };
    installEventTracer(core);
    // (Active-extensions banner is shown by showWorkspaceBanners, grouped with
    // the workspace-context lines.)
    // Surface any extension load failures (version mismatch, throw in activate),
    // so a broken extension is visible instead of silently missing.
    for (const w of getExtensionHost().getWarnings()) history.addError(`extension: ${w}`);
    return restoreConsole;
}

/**
 * Event tracer: dim trace lines in the chat + ~/.loop/events-debug.log.
 * Off by default; LOOP_DEBUG_EVENTS=1 enables at startup, Shift+Ctrl+D
 * toggles at runtime.
 */
function installEventTracer(core: AppCore): void {
    const { tui, history } = core;
    setEventTraceSink((line) => {
        history.addSystem(dim(`· ${line}`));
        tui.requestRender();
    });
    tui.onDebug = () => {
        const on = toggleEventTrace();
        history.addSystem(dim(`· event trace ${on ? "ON" : "off"} → ~/${CONFIG_DIR_NAME}/events-debug.log`));
        tui.requestRender();
    };
    if (isEventTraceEnabled()) {
        history.addSystem(dim(`· event trace ON (${envName("DEBUG_EVENTS")}) — Shift+Ctrl+D to toggle`));
    }
}
