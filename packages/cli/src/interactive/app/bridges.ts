/**
 * Hands the TUI's menus to the code that asks through them: extensions
 * (api.ui, widgets, keymap) and core's ask / approval / elicitation bridges.
 */
import {
    getExtensionHost,
    setAskUserBridge,
    setBashApprovalBridge,
    setMcpElicitationBridge,
    type AskUserBridge,
} from "@notshekhar/loop-core";
import { createExtensionUiServices } from "../extension-widgets";
import { createAskUserBridge } from "../ask-user";
import { createMcpElicitationBridge } from "../mcp-elicit";
import { createBashApprovalBridge } from "../bash-approve";
import { rosterOf, type AppCore } from "./context";
import { editorTheme, type Layout } from "./layout";
import type { Modals } from "./modals";

/**
 * Expose the interactive menus/prompts to extensions (api.ui). SelectItem is
 * structurally identical to the extension API's UiSelectItem, so the lists
 * pass straight through. Used by extension command handlers, which only run
 * once the app is interactive — so wiring it here (after init) is fine.
 */
export function exposeUiToExtensions(core: AppCore, layout: Layout, modals: Modals): void {
    const { tui, history, state } = core;
    getExtensionHost().setServices({
        ui: {
            select: (items, title, opts) => modals.selectOnce(items, title, opts),
            search: (items, title, opts) => modals.searchOnce(items, title, opts),
            prompt: (label, initial) => modals.promptOnce(label, initial),
            note: chatNote(core),
            error: (text) => {
                history.addError(text);
                tui.requestRender();
            },
        },
        // Lets a live status line (e.g. the vitals layout's clock/CPU) repaint
        // itself between user actions.
        requestRender: () => tui.requestRender(),
        // Widgets + global key bindings (api.widgets / api.keymap). Interactive
        // only: print mode injects neither, so `show` returns undefined there
        // rather than drawing into a screen that does not exist.
        ...createExtensionUiServices(
            tui,
            layout.dockHost,
            {
                isPinned: () => state.pinnedInput,
                setPinned: (on: boolean) => layout.applyPinnedInput(on),
                // Closing or unfocusing a panel has to give the keyboard back,
                // or the user is left typing into nothing.
                focusEditor: () => tui.setFocus(layout.editor),
            },
            (err: unknown) => {
                history.addError(`extension UI: ${(err as Error).message ?? String(err)}`);
                tui.requestRender();
            },
        ),
    });
}

/**
 * All three are gated on the asking session being on screen: a question
 * from a session working in the background parks (the switcher shows it
 * as needing you) instead of opening over the one you are looking at.
 *
 * Returns the ask UI itself, ungated, for remote turns to open.
 */
export function registerCoreBridges(core: AppCore, modals: Modals): AskUserBridge {
    // Ask tool UI bridge — registering it is also what makes runTurn offer the
    // tool at all (print mode never registers, so no gate needed there).
    const askBridge = createAskUserBridge({ host: modals.selectorHost, editorTheme });
    setAskUserBridge({
        ask: (questions, o) =>
            rosterOf(core).gated(
                "question",
                o?.signal,
                () => askBridge.ask(questions, o),
                () => questions.map(() => ({ answers: [], declined: true })),
            ),
    });

    // Bash approval bridge — only registered here (interactive), so the
    // bashApprove setting has no effect in print mode / RPC. The setting
    // itself is checked in the bash tool; the bridge is just the UI.
    const approvalBridge = createBashApprovalBridge(modals.selectorHost);
    setBashApprovalBridge({
        confirm: (req, o) =>
            rosterOf(core).gated(
                `${req.kind ?? "bash"} approval`,
                o?.signal,
                () => approvalBridge.confirm(req, o),
                () => "deny",
            ),
    });

    // MCP elicitation — a server asking the user something mid-tool-call.
    // Interactive only; elsewhere core declines rather than stalling the call.
    const elicitBridge = createMcpElicitationBridge({
        selectOnce: modals.selectOnce,
        promptOnce: modals.promptOnce,
        say: chatNote(core),
    });
    setMcpElicitationBridge({
        elicit: (request, o) =>
            rosterOf(core).gated(
                "MCP request",
                o?.signal,
                () => elicitBridge.elicit(request, o),
                () => ({ action: "cancel" }),
            ),
    });
    return askBridge;
}

/** A system line in the chat, painted right away. */
function chatNote(core: AppCore): (text: string) => void {
    return (text) => {
        core.history.addSystem(text);
        core.tui.requestRender();
    };
}
