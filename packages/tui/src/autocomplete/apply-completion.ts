import type { AppliedCompletion, AutocompleteItem } from "./types";

/** Replace the prefix before the cursor with the chosen item. */

function withLine(lines: string[], cursorLine: number, newLine: string): string[] {
    const newLines = [...lines];
    newLines[cursorLine] = newLine;
    return newLines;
}

/** Where the cursor lands inside the inserted value: before the closing quote of a quoted directory. */
function cursorOffsetIn(item: AutocompleteItem): number {
    const isDirectory = item.label.endsWith("/");
    const hasTrailingQuote = item.value.endsWith('"');
    return isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;
}

/** Text after the cursor, minus a closing quote the completed (quoted) value already supplies. */
function afterCursorFor(afterCursor: string, item: AutocompleteItem, prefix: string): string {
    const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
    const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
    const hasTrailingQuoteInItem = item.value.endsWith('"');
    return isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;
}

export function applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
): AppliedCompletion {
    const currentLine = lines[cursorLine] || "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const adjustedAfterCursor = afterCursorFor(currentLine.slice(cursorCol), item, prefix);

    // Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
    // Slash commands are at the start of the line and don't contain path separators after the first /
    const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
    if (isSlashCommand) {
        return {
            lines: withLine(lines, cursorLine, `${beforePrefix}/${item.value} ${adjustedAfterCursor}`),
            cursorLine,
            cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
        };
    }

    // Check if we're completing a file attachment (prefix starts with "@")
    if (prefix.startsWith("@")) {
        // Don't add space after directories so user can continue autocompleting
        const suffix = item.label.endsWith("/") ? "" : " ";
        return {
            lines: withLine(lines, cursorLine, `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`),
            cursorLine,
            cursorCol: beforePrefix.length + cursorOffsetIn(item) + suffix.length,
        };
    }

    // Command arguments and plain file paths both replace the prefix in place.
    return {
        lines: withLine(lines, cursorLine, beforePrefix + item.value + adjustedAfterCursor),
        cursorLine,
        cursorCol: beforePrefix.length + cursorOffsetIn(item),
    };
}
