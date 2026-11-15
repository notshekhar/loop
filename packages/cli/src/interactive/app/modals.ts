/**
 * Modal menus and prompts: the one place a selector is painted over the
 * frame, and the select / search / prompt / toggle helpers built on it.
 */
import type { Container, SelectItem, SelectList } from "@notshekhar/loop-tui";
import { SelectorOverlay } from "../components/selector-overlay";
import {
    selectOnce as selectOnceShared,
    searchSelectOnce as searchSelectOnceShared,
    promptOnce as promptOnceShared,
    toggleSelectOnce,
    type SelectorHost,
} from "../selectors";
import type { AgentStatusBus } from "../agent-status";
import type { AppDeps } from "../deps";
import type { AppCore } from "./context";
import { editorTheme, type Layout } from "./layout";
import type { Viewport } from "./viewport";

export type Modals = Pick<
    AppDeps,
    "showSelector" | "getSelectorDepth" | "selectOnce" | "searchOnce" | "promptOnce" | "toggleOnce"
> & { selectorHost: SelectorHost };

export function createModals(core: AppCore, layout: Layout, viewport: Viewport, agentStatus: AgentStatusBus): Modals {
    // Open-selector count — timer/reminder prompts wait until the slot is free.
    const depth = { open: 0 };
    const showSelector = createShowSelector(core, layout, viewport, agentStatus, depth);
    const selectorHost: SelectorHost = { tui: core.tui, showSelector };
    return {
        selectorHost,
        showSelector,
        getSelectorDepth: () => depth.open,
        selectOnce: (items: SelectItem[], title?: string, opts?: { initialIndex?: number }) =>
            selectOnceShared(selectorHost, items, title, opts),
        searchOnce: (
            items: SelectItem[],
            title?: string,
            opts?: { initialIndex?: number; loadMore?: () => Promise<SelectItem[]> },
        ) => searchSelectOnceShared(selectorHost, items, title, opts),
        promptOnce: (label?: string, initial?: string) => promptOnceShared(selectorHost, editorTheme, label, initial),
        toggleOnce: (values: string[], initial: Set<string>, title?: string) =>
            toggleSelectOnce(selectorHost, values, initial, title),
    };
}

function createShowSelector(
    core: AppCore,
    layout: Layout,
    viewport: Viewport,
    agentStatus: AgentStatusBus,
    depth: { open: number },
): AppDeps["showSelector"] {
    const { tui } = core;
    const { editor, editorContainer } = layout;
    return (component: Container, focusable: Container | SelectList, label?: string): (() => void) => {
        depth.open++;
        // Every modal prompt passes through here — but only agent-driven
        // waits (labeled: ask tool, approvals) count as blocked for watchers.
        // User-opened menus (/settings, pickers) are not the agent waiting.
        const modalClosed = label ? agentStatus.modalOpened(label) : undefined;

        // Swapping the selector in for the editor makes the frame taller, and a
        // frame that reaches the bottom of the screen answers that by
        // scrolling — which commits the rows at the top to the terminal's
        // scrollback, where they cannot be taken back. Closing the selector
        // shortens the frame again, those rows cannot come home, and the prompt
        // is left that much higher. Toggling pinned input in /settings is the
        // sharpest version: the menu itself pushed twelve rows off, so the
        // setting looked like it did nothing.
        //
        // Painted OVER the frame, a selector costs it no rows at all — nothing
        // scrolls going in, so there is nothing to give back coming out. It is
        // anchored to the bottom of the FRAME (rowsBelowFrame), not the bottom
        // of the screen, so a short transcript keeps the menu on the prompt
        // instead of leaving it floating at the bottom of the terminal.
        viewport.revealPrompt();
        const overlay = tui.showOverlay(
            new SelectorOverlay(component, () => editorContainer.render(tui.terminal.columns).length),
            {
                width: "100%",
                // Never taller than the room it has: an overlay the frame must
                // grow for is a scroll again.
                maxHeight: "100%",
                anchor: "bottom-left",
                margin: () => ({ bottom: viewport.rowsBelowFrame() + viewport.rowsBelowEditor() }),
                // Wheeled off along with the prompt it sits on; the next key
                // brings both back (revealPrompt in the input handler).
                visible: viewport.promptOnScreen,
                // Focus goes to the inner list, not the wrapper.
                nonCapturing: true,
            },
        );
        tui.setFocus(focusable as never);
        tui.invalidate();
        tui.requestRender();
        return () => {
            depth.open--;
            modalClosed?.();
            overlay.hide();
            tui.setFocus(editor);
            tui.invalidate();
            tui.requestRender();
        };
    };
}
