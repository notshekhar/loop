import { CURSOR_MARKER } from "../../tui";
import { getGraphemeSegmenter, sliceByColumn, truncateToWidth, visibleWidth } from "../../utils";

const segmenter = getGraphemeSegmenter();

/** Everything the single-line input needs to draw itself. */
export interface InputView {
    prompt: string;
    value: string;
    cursor: number;
    placeholder: string;
    placeholderStyle: (text: string) => string;
    focused: boolean;
}

/** The part of the value that fits, and where the cursor sits inside it. */
interface VisibleWindow {
    visibleText: string;
    cursorDisplay: number;
}

/** First grapheme of `text`, or a space when empty (the cursor drawn at the end). */
function firstGraphemeOrSpace(text: string): string {
    return [...segmenter.segment(text)][0]?.segment ?? " ";
}

/** Use inverse video to show the cursor: ESC[7m = reverse video, ESC[27m = normal. */
function invert(text: string): string {
    return `\x1b[7m${text}\x1b[27m`;
}

function padToWidth(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
function cursorMarker(view: InputView): string {
    return view.focused ? CURSOR_MARKER : "";
}

function renderPlaceholder(view: InputView, availableWidth: number): string {
    const placeholder = truncateToWidth(view.placeholder, availableWidth, "");
    const atCursor = firstGraphemeOrSpace(placeholder);
    const afterCursor = placeholder.slice(atCursor.length);
    const textWithCursor =
        cursorMarker(view) + invert(view.placeholderStyle(atCursor)) + view.placeholderStyle(afterCursor);
    return view.prompt + padToWidth(textWithCursor, availableWidth);
}

/** Scroll horizontally so the cursor stays visible, centred when it is mid-text. */
function scrollWindow(value: string, cursor: number, availableWidth: number): VisibleWindow {
    const totalWidth = visibleWidth(value);
    if (totalWidth < availableWidth) {
        // Everything fits (leave room for cursor at end)
        return { visibleText: value, cursorDisplay: cursor };
    }

    // Reserve one column for cursor if it's at the end
    const scrollWidth = cursor === value.length ? availableWidth - 1 : availableWidth;
    if (scrollWidth <= 0) {
        return { visibleText: "", cursorDisplay: 0 };
    }

    const cursorCol = visibleWidth(value.slice(0, cursor));
    const halfWidth = Math.floor(scrollWidth / 2);
    let startCol: number;
    if (cursorCol < halfWidth) {
        // Cursor near start
        startCol = 0;
    } else if (cursorCol > totalWidth - halfWidth) {
        // Cursor near end
        startCol = Math.max(0, totalWidth - scrollWidth);
    } else {
        // Cursor in middle
        startCol = Math.max(0, cursorCol - halfWidth);
    }

    const visibleText = sliceByColumn(value, startCol, scrollWidth, true);
    const beforeCursor = sliceByColumn(value, startCol, Math.max(0, cursorCol - startCol), true);
    return { visibleText, cursorDisplay: beforeCursor.length };
}

function renderValue(view: InputView, availableWidth: number): string {
    const { visibleText, cursorDisplay } = scrollWindow(view.value, view.cursor, availableWidth);
    const beforeCursor = visibleText.slice(0, cursorDisplay);
    const atCursor = firstGraphemeOrSpace(visibleText.slice(cursorDisplay));
    const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);
    const textWithCursor = beforeCursor + cursorMarker(view) + invert(atCursor) + afterCursor;
    return view.prompt + padToWidth(textWithCursor, availableWidth);
}

/** The input's one line: prompt, then the value (or placeholder) with a fake cursor. */
export function renderInputLine(view: InputView, width: number): string {
    const availableWidth = width - visibleWidth(view.prompt);
    if (availableWidth <= 0) {
        return truncateToWidth(view.prompt, width, "");
    }
    if (view.value.length === 0 && view.placeholder) {
        return renderPlaceholder(view, availableWidth);
    }
    return renderValue(view, availableWidth);
}
