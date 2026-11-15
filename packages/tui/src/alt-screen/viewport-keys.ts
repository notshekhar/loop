import type { Keybinding } from "../keybindings";

/** Rows kept from the previous page when paging, so reading stays continuous. */
const PAGE_SCROLL_OVERLAP = 4;

export interface ViewportScroller {
    viewportHeight(): number;
    scrollBy(lines: number): void;
    scrollToPrompt(direction: -1 | 1): void;
    scrollToTop(): void;
    scrollToBottom(): void;
}

/** The keys that scroll the transcript, and what each does. */
export function viewportKeyActions(view: ViewportScroller): Array<[Keybinding, () => void]> {
    const page = () => Math.max(1, view.viewportHeight() - PAGE_SCROLL_OVERLAP);
    const halfPage = () => Math.max(1, Math.floor(view.viewportHeight() / 2));
    return [
        ["tui.altScreen.pageUp", () => view.scrollBy(-page())],
        ["tui.altScreen.pageDown", () => view.scrollBy(page())],
        ["tui.altScreen.halfPageUp", () => view.scrollBy(-halfPage())],
        ["tui.altScreen.halfPageDown", () => view.scrollBy(halfPage())],
        ["tui.altScreen.lineUp", () => view.scrollBy(-1)],
        ["tui.altScreen.lineDown", () => view.scrollBy(1)],
        ["tui.altScreen.previousPrompt", () => view.scrollToPrompt(-1)],
        ["tui.altScreen.nextPrompt", () => view.scrollToPrompt(1)],
        ["tui.altScreen.top", () => view.scrollToTop()],
        ["tui.altScreen.bottom", () => view.scrollToBottom()],
    ];
}
