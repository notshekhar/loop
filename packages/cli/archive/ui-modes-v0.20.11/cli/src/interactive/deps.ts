import type { Container, Editor, SelectItem, SelectList, TUI } from "@notshekhar/loop-tui";
import type { CommandRegistry, CostTracker, Session, SessionManager, UsageBlock } from "@notshekhar/loop-core";
import type { ChatHistory } from "./components/chat-history";
import type { StatusLine } from "./components/status-line";
import type { TodoPanel } from "./components/todo-panel";
import type { ShellsPanel } from "./components/shells-panel";

/**
 * Stable references for handlers. Functions and objects here don't change
 * across the app's lifetime — only the AppState fields mutate.
 */
export interface AppDeps {
    tui: TUI;
    history: ChatHistory;
    statusLine: StatusLine;
    /** Pinned checklist the todo tool maintains (below the loader, above the editor). */
    todoPanel: TodoPanel;
    /** Pinned list of background shells (bash run_in_background). */
    shellsPanel: ShellsPanel;
    tracker: CostTracker;
    editor: Editor;
    commands: CommandRegistry;
    manager: SessionManager;
    queuedMessages: string[];
    refreshStatusLine: (usage?: UsageBlock) => void;
    refreshStatusLineCtx: (usage?: UsageBlock) => void;
    renderPending: () => void;
    showWorking: (msg?: string) => void;
    hideWorking: () => void;
    showSelector: (component: Container, focusable: Container | SelectList, label?: string) => () => void;
    /** Open-selector count — >0 means a menu/prompt owns the input right now. */
    getSelectorDepth: () => number;
    selectOnce: (items: SelectItem[], title?: string, opts?: { initialIndex?: number }) => Promise<SelectItem | null>;
    /** Single-select with a type-to-filter search box (long lists). */
    searchOnce: (items: SelectItem[], title?: string, opts?: { initialIndex?: number }) => Promise<SelectItem | null>;
    /** Multi-select toggle list (Enter/Space toggles, done confirms, Esc → null). */
    toggleOnce: (values: string[], initial: Set<string>, title?: string) => Promise<string[] | null>;
    promptOnce: (label?: string, initial?: string) => Promise<string>;
    resolveModelId: (input: string) => Promise<string | null>;
    /** Rebuild slash-command autocomplete after runtime command changes (agent create/delete). */
    refreshCommands: () => void;
    ensureSession: () => Promise<Session>;
    cleanExit: (code?: number) => void;
    /** App version (undefined in dev runs). */
    version?: string;
    /** Undo the console→chat bridge before handing the terminal to a child process. */
    restoreConsole: () => void;
    /** Start/stop the shared 1s ticker after clock/timer/reminder changes. */
    syncTicker: () => void;
    /** Apply the `pinnedInput` setting live: swap the layout, repaint. */
    applyPinnedInput: (on: boolean) => void;
    /**
     * The window the transcript is currently shown through, in transcript
     * lines: `top` is the first transcript line on screen, `height` how many
     * screen rows the transcript may occupy. Maps a clicked row to an entry.
     */
    transcriptViewport: () => { top: number; height: number };
    /**
     * Scroll the prompt back into view if the transcript was scrolled away
     * from it (flowing layout only; pinned, it never leaves). Called on
     * keyboard input and when a menu opens on the prompt.
     */
    revealPrompt: () => void;
    /** Jump the transcript to its newest line and resume following it. */
    scrollTranscriptToEnd: () => void;
}
