/**
 * Route stray console output and escaped errors into the chat so they never
 * tear the TUI renderer by writing to stdout/stderr directly.
 */
import type { TUI } from "@notshekhar/loop-tui";
import type { ChatHistory } from "./components/chat-history";
import { formatError } from "./format-error";

/** Returns a restore function — needed when the TUI hands the terminal back
 * (e.g. /update runs the installer with inherited stdio). */
export function installConsoleBridge(history: ChatHistory, tui: TUI): () => void {
    // Stray console output from libraries (warnings, deprecation notices)
    // bypasses the renderer and tears frames. Route it into the chat as
    // messages instead — errors red, the rest dim. stdout/stderr writes from
    // native code still bypass this, but console.* covers the practical cases.
    const origConsole = { log: console.log, warn: console.warn, error: console.error };
    const fmt = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    console.log = (...args: unknown[]) => {
        history.addSystem(fmt(args));
        tui.requestRender();
    };
    console.warn = (...args: unknown[]) => {
        history.addSystem(fmt(args));
        tui.requestRender();
    };
    // Errors get formatError per arg so a stray console.error(apiError) shows
    // the real message, not a JSON dump of the whole request.
    const fmtErr = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : formatError(a))).join(" ");
    console.error = (...args: unknown[]) => {
        history.addError(fmtErr(args));
        tui.requestRender();
    };
    const restore = () => Object.assign(console, origConsole);
    process.once("exit", restore);

    // Last-resort error surfacing: anything that escapes a handler renders in
    // chat instead of tearing the TUI via stderr or killing the process.
    // Display only — errors are never written to the session transcript.
    const surfaceError = createErrorSurface(history, tui);
    process.on("uncaughtException", (err) => surfaceError("uncaught", err));
    process.on("unhandledRejection", (err) => surfaceError("unhandled", err));

    return restore;
}

/** How long an identical error is counted rather than shown again. */
const REPEAT_WINDOW_MS = 5_000;

/**
 * Show an escaped error in the chat — without AMPLIFYING it.
 *
 * An error that recurs on every tick (a timer, a render) used to add a chat
 * line and request a repaint each time; the repaint could raise it again, and
 * the transcript grew by one line per frame until the UI stopped responding.
 * The same message inside the quiet window is counted instead, and the count
 * is reported once the next different error arrives.
 */
export function createErrorSurface(
    history: Pick<ChatHistory, "addError">,
    tui: Pick<TUI, "requestRender">,
    now: () => number = Date.now,
): (prefix: string, err: unknown) => void {
    let last: { text: string; at: number; repeats: number } | null = null;
    return (prefix, err) => {
        const text = `${prefix}: ${formatError(err)}`;
        const at = now();
        if (last && last.text === text && at - last.at < REPEAT_WINDOW_MS) {
            last.repeats++;
            last.at = at;
            return;
        }
        if (last && last.repeats > 0) history.addError(`${last.text} (repeated ${last.repeats}×)`);
        last = { text, at, repeats: 0 };
        history.addError(text);
        tui.requestRender();
    };
}
