/**
 * Naming the session, once, from its opening exchange.
 *
 * A session that is only a ULID and a cwd is unidentifiable the moment you
 * are not looking at it — which is exactly when something else is showing it
 * to you: a terminal tab, a cmux pane's sidebar card, a notification on a
 * phone. So the first turn earns a title, the title becomes the session's
 * name AND the terminal's title, and everything downstream inherits it for
 * free (cmux reads the terminal title for the pane's card, and `/sessions`
 * lists names).
 *
 * Deliberately once, and deliberately early: the opening exchange is what the
 * session is about, later turns drift, and a name that keeps changing is
 * worse than one that is slightly stale. A name the user set with `/name` is
 * never overwritten.
 */
import { PRODUCT_TITLE, generateSessionTitle } from "@notshekhar/loop-core";
import type { AgentStatusBus } from "./agent-status";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import { traceEvent } from "./debug-log";

/**
 * The tab also says what loop is DOING, because a title alone cannot: a row
 * of panes all reading "Fix the pty test" tells you nothing about which one
 * is still thinking and which is waiting on you. Braille spinner while a turn
 * runs (loop's own frames, the ones the working indicator uses), a filled
 * marker when a prompt needs you, nothing at all when idle — an idle pane
 * should read as its name, not as a status.
 */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BLOCKED_GLYPH = "◆";
/** Slower than the on-screen spinner: this repaints someone else's chrome. */
const SPIN_INTERVAL_MS = 250;

/** Sessions already titled in this process — one attempt each, ever. */
const attempted = new Set<string>();

/**
 * What the tab reads when the live session has no name of its own: at launch,
 * and again the moment /new or /clear throws the old session away. The title
 * belongs to a SESSION, so it cannot outlive one — a tab still advertising
 * "Fix the pty test" over an empty session is worse than no title at all,
 * because the thing it names is gone.
 *
 * A constant rather than the folder name, which is what Claude Code does
 * (`renamed ?? topic ?? … ?? "Claude Code"`): the folder is already on screen
 * and in the status line, while the one thing the tab can say that nothing
 * else does is WHICH AGENT this pane is.
 */
export function defaultTabName(): string {
    return PRODUCT_TITLE;
}

/** OSC 0 is the tab's name in every terminal worth the word, cmux included. */
export function setTerminalTitle(deps: AppDeps, title: string): void {
    try {
        deps.tui.setTitle(title);
    } catch {
        // A terminal that refuses a title is not a reason to fail a turn.
    }
}

/**
 * The tab title is two independent halves — the session's name, and the state
 * glyph in front of it — written by two different things (the titler, and the
 * status bus). They live here so either can change without erasing the other:
 * a title arriving mid-turn must not blank the spinner for a frame.
 */
let currentTitle = "";
let currentPrefix = "";
let paintTab: (() => void) | undefined;

/**
 * Keep the terminal's tab showing this pane's name AND its state, the way
 * Claude Code's does. Returns a stop function; the caller stops it on exit so
 * the last thing written is a plain, un-spinning title rather than whichever
 * animation frame happened to be showing.
 */
export function attachTerminalTitle(bus: AgentStatusBus, deps: AppDeps, initialTitle: string): () => void {
    currentTitle = initialTitle;
    currentPrefix = "";
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    const repaint = (): void => {
        setTerminalTitle(deps, currentPrefix ? `${currentPrefix} ${currentTitle}` : currentTitle);
    };
    paintTab = repaint;

    const paint = (prefix: string): void => {
        currentPrefix = prefix;
        repaint();
    };

    const stopSpin = (): void => {
        if (!timer) return;
        clearInterval(timer);
        timer = undefined;
    };

    const apply = (status: "idle" | "working" | "blocked"): void => {
        if (status === "working") {
            if (timer) return; // already spinning — don't restart the animation
            paint(SPINNER[frame]);
            timer = setInterval(() => {
                frame = (frame + 1) % SPINNER.length;
                paint(SPINNER[frame]);
            }, SPIN_INTERVAL_MS);
            timer.unref?.();
            return;
        }
        stopSpin();
        paint(status === "blocked" ? BLOCKED_GLYPH : "");
    };

    bus.on((e) => apply(e.status));
    apply(bus.current().status);

    return () => {
        stopSpin();
        paint("");
        paintTab = undefined;
    };
}

/** Rename the tab, keeping whatever state glyph is currently showing. */
export function setTabName(deps: AppDeps, name: string): void {
    currentTitle = name;
    if (paintTab) paintTab();
    else setTerminalTitle(deps, name);
}

/**
 * Title the session if it hasn't been, then show it. Best-effort and
 * detached: callers must not await this, and every failure is silent — the
 * session simply keeps the identity it had.
 */
export async function maybeTitleSession(
    state: AppState,
    deps: AppDeps,
    turn: { userInput: string; assistantText: string; aborted: boolean },
): Promise<void> {
    const session = state.session;
    if (!session || turn.aborted) return;
    // An interrupted turn says nothing about the session's subject, and a
    // name the user chose outranks anything a model would pick.
    if (session.getName() || attempted.has(session.id)) return;
    if (!state.modelId) return;
    attempted.add(session.id);

    try {
        const title = await generateSessionTitle({
            userInput: turn.userInput,
            assistantText: turn.assistantText,
            modelId: state.modelId,
            tracker: deps.tracker,
            sessionPub: session.id,
            cwd: state.cwd,
        });
        if (!title) return;
        // The session may have been renamed, replaced (/new), or ended while
        // the model was thinking — check again before writing.
        if (state.session?.id !== session.id || session.getName()) return;
        await session.setName(title);
        // The tab names what is on screen; a session titled in the
        // background shows its name in the switcher instead.
        if (deps.isForeground()) setTabName(deps, title);
        traceEvent("session-title", title);
    } catch {
        // Best-effort by design: an unnamed session is a cosmetic loss.
    }
}
