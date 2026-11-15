import { homedir } from "os";
import { join } from "path";

/**
 * Reading the path-like token at the cursor: where it starts, whether it is an
 * `@` attachment and/or quoted, and how a completed path is written back.
 */

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export interface ParsedPathPrefix {
    rawPrefix: string;
    isAtPrefix: boolean;
    isQuotedPrefix: boolean;
}

export function toDisplayPath(value: string): string {
    return value.replace(/\\/g, "/");
}

function findLastDelimiter(text: string): number {
    for (let i = text.length - 1; i >= 0; i -= 1) {
        if (PATH_DELIMITERS.has(text[i] ?? "")) {
            return i;
        }
    }
    return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
    let inQuotes = false;
    let quoteStart = -1;

    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '"') {
            inQuotes = !inQuotes;
            if (inQuotes) {
                quoteStart = i;
            }
        }
    }

    return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
    return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractQuotedPrefix(text: string): string | null {
    const quoteStart = findUnclosedQuoteStart(text);
    if (quoteStart === null) {
        return null;
    }

    if (quoteStart > 0 && text[quoteStart - 1] === "@") {
        if (!isTokenStart(text, quoteStart - 1)) {
            return null;
        }
        return text.slice(quoteStart - 1);
    }

    if (!isTokenStart(text, quoteStart)) {
        return null;
    }

    return text.slice(quoteStart);
}

/** The text of the token the cursor is in (everything after the last delimiter). */
function lastToken(text: string): string {
    const lastDelimiterIndex = findLastDelimiter(text);
    return lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);
}

export function parsePathPrefix(prefix: string): ParsedPathPrefix {
    if (prefix.startsWith('@"')) {
        return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
    }
    if (prefix.startsWith('"')) {
        return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
    }
    if (prefix.startsWith("@")) {
        return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
    }
    return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

/** Write a completed path back, keeping the `@` and quoting it when it was quoted or has a space. */
export function buildCompletionValue(path: string, options: { isAtPrefix: boolean; isQuotedPrefix: boolean }): string {
    const needsQuotes = options.isQuotedPrefix || path.includes(" ");
    const prefix = options.isAtPrefix ? "@" : "";

    if (!needsQuotes) {
        return `${prefix}${path}`;
    }

    const openQuote = `${prefix}"`;
    const closeQuote = '"';
    return `${openQuote}${path}${closeQuote}`;
}

/** Extract an `@` prefix for fuzzy file suggestions. */
export function extractAtPrefix(text: string): string | null {
    const quotedPrefix = extractQuotedPrefix(text);
    if (quotedPrefix?.startsWith('@"')) {
        return quotedPrefix;
    }

    const token = lastToken(text);
    return token.startsWith("@") ? token : null;
}

/** Extract a path-like prefix from the text before the cursor. */
export function extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
    const quotedPrefix = extractQuotedPrefix(text);
    if (quotedPrefix) {
        return quotedPrefix;
    }

    const pathPrefix = lastToken(text);

    // For forced extraction (Tab key), always return something
    if (forceExtract) {
        return pathPrefix;
    }

    // For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
    // Only return empty string if the text looks like it's starting a path context
    if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
        return pathPrefix;
    }

    // Return empty string only after a space (not for completely empty text)
    // Empty text should not trigger file suggestions - that's for forced Tab completion
    if (pathPrefix === "" && text.endsWith(" ")) {
        return pathPrefix;
    }

    return null;
}

/** Expand the home directory (`~/`) to the actual home path. */
export function expandHomePath(path: string): string {
    if (path.startsWith("~/")) {
        const expandedPath = join(homedir(), path.slice(2));
        // Preserve trailing slash if original path had one
        return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
    } else if (path === "~") {
        return homedir();
    }
    return path;
}
