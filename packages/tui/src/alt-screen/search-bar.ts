import type { Component, Focusable } from "../component";
import { Input } from "../components/input";
import { getKeybindings } from "../keybindings";
import { truncateToWidth, visibleWidth } from "../utils";

/** Cells of border either side of the navigation buttons. */
const BUTTON_GAP = 1;

/** "ctrl+alt+n" → "Ctrl+Option+N" on macOS, "Ctrl+Alt+N" elsewhere; "Unbound" when there is no key. */
function formatKeyLabel(key: string | undefined): string {
    if (!key) return "Unbound";
    return key
        .split("+")
        .map((part) => {
            if (process.platform === "darwin" && part.toLowerCase() === "alt") return "Option";
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join("+");
}

export class AltScreenSearchComponent implements Component, Focusable {
    private readonly input = new Input({
        prompt: " ",
        placeholder: "Find in transcript",
        placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
    });
    private readonly onQueryChange: (query: string) => void;
    private readonly navigationButtonStyle: (text: string, hovered: boolean) => string;
    private resultCount = 0;
    private resultIndex = -1;
    private previousButtonStart = -1;
    private previousButtonEnd = -1;
    private nextButtonStart = -1;
    private nextButtonEnd = -1;
    private hoveredNavigationDirection: -1 | 1 | undefined;
    private _focused = false;

    constructor(
        onQueryChange: (query: string) => void,
        navigationButtonStyle: (text: string, hovered: boolean) => string = (text) => text,
    ) {
        this.onQueryChange = onQueryChange;
        this.navigationButtonStyle = navigationButtonStyle;
    }

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        this.input.focused = value;
    }

    setResult(index: number, count: number): void {
        this.resultIndex = index;
        this.resultCount = count;
    }

    getNavigationDirectionAt(row: number, column: number): -1 | 1 | undefined {
        if (row !== 2) return undefined;
        if (column >= this.previousButtonStart && column < this.previousButtonEnd) return -1;
        if (column >= this.nextButtonStart && column < this.nextButtonEnd) return 1;
        return undefined;
    }

    setHoveredNavigationDirection(direction: -1 | 1 | undefined): boolean {
        if (direction === this.hoveredNavigationDirection) return false;
        this.hoveredNavigationDirection = direction;
        return true;
    }

    handleInput(data: string): void {
        const previous = this.input.getValue();
        this.input.handleInput(data);
        const query = this.input.getValue();
        if (query !== previous) this.onQueryChange(query);
    }

    invalidate(): void {
        this.input.invalidate();
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const innerWidth = Math.max(0, safeWidth - 2);
        const content = this.queryRow(innerWidth);
        const navigation = this.layoutNavigation(innerWidth);
        if (safeWidth === 1) return ["┌", "│", "└"];
        const { buttons, leftRuleWidth, rightRuleWidth } = navigation;
        const padded = buttons ? ` ${buttons} ` : "";
        return [
            `┌${"─".repeat(innerWidth)}┐`,
            `│${content}│`,
            `└${"─".repeat(leftRuleWidth)}${padded}${"─".repeat(rightRuleWidth)}┘`,
        ];
    }

    /** The input, padded out, with "3/12" (or "No matches") dimmed at the right. */
    private queryRow(innerWidth: number): string {
        const query = this.input.getValue();
        const result = !query
            ? ""
            : this.resultCount === 0
              ? "No matches"
              : `${this.resultIndex + 1}/${this.resultCount}`;
        const visibleResult = truncateToWidth(result, Math.max(0, innerWidth - 3), "");
        const resultText = visibleResult ? `\x1b[2m ${visibleResult} \x1b[22m` : "";
        const inputWidth = Math.max(0, innerWidth - visibleWidth(resultText));
        const inputLine = truncateToWidth(this.input.render(Math.max(1, inputWidth))[0] ?? "", inputWidth, "");
        const inputPadding = " ".repeat(Math.max(0, inputWidth - visibleWidth(inputLine)));
        return `${inputLine}${inputPadding}${resultText}`;
    }

    /**
     * The previous/next buttons sit in the bottom border, labelled with their
     * keys when there is room, as bare arrows when not, and not at all below
     * that. Records where they landed so clicks can find them.
     */
    private layoutNavigation(innerWidth: number) {
        const keybindings = getKeybindings();
        let previousButton = `↑ ${formatKeyLabel(keybindings.getKeys("tui.altScreen.searchPrevious")[0])}`;
        let nextButton = `↓ ${formatKeyLabel(keybindings.getKeys("tui.altScreen.searchNext")[0])}`;
        let separator = " · ";
        const availableControlsWidth = Math.max(0, innerWidth - BUTTON_GAP * 2 - 1);
        const widthOf = () => visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
        if (widthOf() > availableControlsWidth) {
            previousButton = "↑";
            nextButton = "↓";
            separator = " ";
        }
        const controlsWidth = widthOf();
        const showButtons = controlsWidth <= availableControlsWidth;
        const buttons = showButtons
            ? this.navigationButtonStyle(previousButton, this.hoveredNavigationDirection === -1) +
              separator +
              this.navigationButtonStyle(nextButton, this.hoveredNavigationDirection === 1)
            : "";
        const outerGapsWidth = showButtons ? BUTTON_GAP * 2 : 0;
        const rightRuleWidth = buttons && innerWidth > controlsWidth + outerGapsWidth ? 1 : 0;
        const leftRuleWidth = Math.max(
            0,
            innerWidth - (showButtons ? controlsWidth : 0) - outerGapsWidth - rightRuleWidth,
        );
        const previousStart = 1 + leftRuleWidth + BUTTON_GAP;
        this.previousButtonStart = showButtons ? previousStart : -1;
        this.previousButtonEnd = showButtons ? previousStart + visibleWidth(previousButton) : -1;
        this.nextButtonStart = showButtons ? this.previousButtonEnd + visibleWidth(separator) : -1;
        this.nextButtonEnd = showButtons ? this.nextButtonStart + visibleWidth(nextButton) : -1;
        return { buttons, leftRuleWidth, rightRuleWidth };
    }
}
