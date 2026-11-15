/**
 * The screen: the alt-screen TUI, the chrome under the transcript (loader
 * slot, panels, queued messages, editor, status line) and the two layouts
 * `pinnedInput` switches between.
 */
import {
    Container,
    type Editor,
    ProcessTerminal,
    ScrollView,
    Spacer,
    truncateToWidth,
    TuiAltScreen,
    getKeybindings,
    VStack,
    type Component,
    type EditorTheme,
} from "@notshekhar/loop-tui";
import { setShellPanelPresent, listShells, onShellChange } from "@notshekhar/loop-core";
import { getSelectListTheme, theme } from "../ui/theme";
import { dim, muted } from "../ui/text";
import type { AppCore } from "./context";

/**
 * The composer's chrome. Resolved per call rather than captured once: `/theme`
 * and `/uimode` swap the active theme mid-session, and a captured colour
 * function would keep painting the old palette until restart.
 */
export const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("inputBorder", s),
    commandColor: (s) => theme.fg("inputCommand", s),
    get selectList() {
        return getSelectListTheme();
    },
};

/**
 * A single queued user message, rendered on exactly one line: newlines are
 * collapsed to spaces and anything past the viewport width is cut to a trailing
 * "…" (matching the user-message selector). Keeps the pending list compact no
 * matter how long or multi-line the queued input was.
 */
class PendingMessageLine implements Component {
    constructor(
        private readonly prefix: string,
        private readonly message: string,
    ) {}
    invalidate(): void {}
    render(width: number): string[] {
        const singleLine = this.message.replace(/\s+/g, " ").trim();
        const avail = Math.max(1, width - this.prefix.length);
        return [dim(this.prefix) + muted(truncateToWidth(singleLine, avail))];
    }
}

export function createAltScreenTui(): TuiAltScreen {
    // The chat lives on the alternate screen: turns are never written into the
    // terminal's scrollback, so there are no committed rows to duplicate, band
    // or strand. The transcript is printed once, whole, on the way out.
    return new TuiAltScreen(new ProcessTerminal(), true, undefined, {
        mouse: true,
        // One line per notch is the library default and reads as a stuck
        // wheel; three is what terminals themselves scroll by.
        wheelScrollLines: 3,
        searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
        // Scrolled up while a turn streams, this is the one-click way back.
        scrollToEndIndicator: () => {
            const shortcut = getKeybindings().getKeys("tui.altScreen.bottom")[0];
            const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
            return theme.bg("selectedBg", theme.fg("text", label));
        },
    });
}

export interface Layout {
    editor: Editor;
    /** Holds the editor alone, so its height can be measured on its own. */
    editorContainer: Container;
    /** The fixed-height loader slot above the panels. */
    statusContainer: Container;
    statusIdleSpacer: Spacer;
    /** Everything under the transcript. */
    chrome: Container;
    /** Docked extension panels, under the input. */
    dockHost: VStack;
    /** The transcript's own scroll view while input is pinned. */
    transcriptView: ScrollView;
    renderPending: () => void;
    refreshShells: () => void;
    applyPinnedInput: (on: boolean) => void;
}

export function buildLayout(core: AppCore, editor: Editor): Layout {
    // Editor lives in its own container so we can swap it out for selectors
    const editorContainer = new Container();
    editorContainer.addChild(editor);

    // Fixed-height status slot above editor so editor never shifts.
    // Loader renders 2 rows (leading blank + spinner line) — the idle spacer
    // must match, or the editor/status line block jumps a row on every turn start.
    const statusContainer = new Container();
    const statusIdleSpacer = new Spacer(2);
    statusContainer.addChild(statusIdleSpacer);

    // queued user messages render between status and editor
    const pendingContainer = new Container();
    const renderPending = (): void => {
        const queued = core.queuedMessages;
        pendingContainer.clear();
        for (let i = 0; i < queued.length; i++) {
            pendingContainer.addChild(new PendingMessageLine(` queued ${i + 1}/${queued.length}: `, queued[i]));
        }
    };

    const chrome = new Container();
    const refreshShells = buildChrome(core, chrome, { statusContainer, pendingContainer, editorContainer });
    const { dockHost, transcriptView, applyPinnedInput } = mountFrame(core, chrome);
    return {
        editor,
        editorContainer,
        statusContainer,
        statusIdleSpacer,
        chrome,
        dockHost,
        transcriptView,
        renderPending,
        refreshShells,
        applyPinnedInput,
    };
}

/**
 * Everything under the transcript is chrome: the loader slot, the panels,
 * the editor, the status line. Kept in one container so its height can be
 * measured in one call (the transcript's reserve, the overlays' anchors).
 * Returns the shells panel's repaint.
 */
function buildChrome(
    core: AppCore,
    chrome: Container,
    parts: { statusContainer: Container; pendingContainer: Container; editorContainer: Container },
): () => void {
    const { tui, state, shellsPanel } = core;
    chrome.addChild(parts.statusContainer);
    // Pinned checklist: below the loader slot, above queued messages + editor.
    chrome.addChild(core.todoPanel);
    // Background shells sit under the checklist — the work the agent is doing,
    // then the processes it left running.
    chrome.addChild(shellsPanel);
    // The panel is mounted, so a foreground command that outruns its timeout may
    // be promoted instead of killed: the reason for the timeout is invisibility,
    // and a shell listed here is not invisible.
    setShellPanelPresent(true);
    const refreshShells = () => {
        shellsPanel.setShells(listShells(state.session?.id));
        // A shell starting has to restart the 1s pulse, or its elapsed time sits still.
        core.late.syncTicker();
        tui.requestRender();
    };
    onShellChange(refreshShells);
    chrome.addChild(parts.pendingContainer);
    chrome.addChild(parts.editorContainer);
    chrome.addChild(core.statusLine);
    // Constant breathing room below the status line — without it the status block
    // sits flush with the terminal's bottom row once the screen fills up.
    chrome.addChild(new Spacer(1));
    return refreshShells;
}

/**
 * The document is always the same two blocks — transcript, then chrome —
 * and is what the exit path prints into the terminal. `pinnedInput` only
 * changes how the screen shows it:
 *
 *   off  the alt screen's own follow-end scroll view over the whole
 *        document. A short session reads top-down with the prompt right
 *        under the last message; a long one keeps it on the last rows;
 *        scrolling back moves the page, prompt included — the flow a shell
 *        prompt has under a command's output.
 *   on   a flex frame: the transcript in its own scroll view taking every
 *        row the chrome does not, the chrome held on the last rows. The
 *        wheel moves the transcript only.
 *
 * Both are one renderer; the layout root is set or cleared, the children
 * stay mounted for the exit print either way.
 */
function mountFrame(
    core: AppCore,
    chrome: Container,
): Pick<Layout, "dockHost" | "transcriptView" | "applyPinnedInput"> {
    const { tui, state, history } = core;
    tui.addChild(history);
    tui.addChild(chrome);
    const transcriptView = new ScrollView(history, { follow: "end", primary: true });
    // Sized from the transcript's natural height, not `basis: 0`: the frame
    // gives the same rows either way (the chrome may not shrink, so whatever it
    // does not take is the transcript's), but the exit print renders this stack
    // WITHOUT a viewport, and there a zero basis is zero rows — the whole
    // conversation gone from the terminal on quit.
    // Docked panels (api.docks) sit at the very bottom of the frame, under the
    // input — where VS Code puts its panel. Empty, a VStack renders zero rows,
    // so this costs the frame nothing until something docks.
    const dockHost = new VStack([]);
    const pinnedFrame = new VStack([
        { component: transcriptView, grow: 1, shrink: 1 },
        { component: chrome, shrink: 0 },
        // Left out of the layout entirely while empty. An entry that renders no
        // rows is still an entry, and the frame's own tests notice: the prompt
        // stops being on the last rows of the screen.
        { component: dockHost, shrink: 0, visible: () => dockHost.children.length > 0 },
    ]);
    const applyPinnedInput = (on: boolean): void => {
        state.pinnedInput = on;
        tui.setLayoutRoot(on ? pinnedFrame : undefined);
        tui.requestRender(true);
    };
    if (state.pinnedInput) tui.setLayoutRoot(pinnedFrame);
    return { dockHost, transcriptView, applyPinnedInput };
}
