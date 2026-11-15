import type { TokenizerExtension, Tokens } from "marked";

export interface LatexToken extends Tokens.Generic {
    type: "latex" | "latexBlock";
    text: string;
    pending?: boolean;
}

function isEscaped(source: string, index: number): boolean {
    let backslashes = 0;
    for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
    let index = source.indexOf(closing, start);
    while (index >= 0 && isEscaped(source, index)) {
        index = source.indexOf(closing, index + closing.length);
    }
    return index;
}

function looksLikePendingDollarMath(source: string): boolean {
    return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

/**
 * A closed `$…$` that is really prose: a price ("$5 and $10"), a shell
 * variable ("$HOME/bin"), or code. Single-dollar math must hug its content
 * and not run straight into a digit or identifier.
 */
function isDollarNotMath(source: string, closingIndex: number): boolean {
    const inner = source.slice(1, closingIndex);
    const after = source.slice(closingIndex + 1);
    return (
        /\s$/.test(inner) ||
        /^\d/.test(after) ||
        (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(inner) && /^[A-Za-z_][A-Za-z0-9_]*/.test(after)) ||
        inner.includes("`")
    );
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
    let opening = "";
    let closing = "";
    if (source.startsWith("$$")) {
        opening = "$$";
        closing = "$$";
    } else if (source.startsWith("\\(")) {
        opening = "\\(";
        closing = "\\)";
    } else if (source.startsWith("\\[")) {
        opening = "\\[";
        closing = "\\]";
    } else if (source.startsWith("$") && !/^\$\s/.test(source)) {
        opening = "$";
        closing = "$";
    } else {
        return undefined;
    }

    const closingIndex = findClosingDelimiter(source, closing, opening.length);
    if (closingIndex >= 0 && opening === "$" && isDollarNotMath(source, closingIndex)) {
        return undefined;
    }

    if (closingIndex < 0) {
        const pendingSource = source.slice(opening.length);
        if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
            return { type: "latex", raw: source, text: pendingSource, pending: true };
        }
        return undefined;
    }

    const text = source.slice(opening.length, closingIndex);
    if (!text || text.includes("\n")) {
        return undefined;
    }

    const raw = source.slice(0, closingIndex + closing.length);
    return { type: "latex", raw, text };
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
    const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
    if (dollarMatch?.[1]) {
        return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
    }

    const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
    if (bracketMatch?.[1]) {
        return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
    }

    const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
    if (pendingBracket) {
        return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
    }
    const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
    if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
        return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
    }
    return undefined;
}

export const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
    {
        name: "latexBlock",
        level: "block",
        start(source) {
            const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
            return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
        },
        tokenizer: tokenizeBlockLatex,
    },
    {
        name: "latex",
        level: "inline",
        start(source) {
            const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
                (index) => index >= 0,
            );
            return indices.length > 0 ? Math.min(...indices) : undefined;
        },
        tokenizer: tokenizeInlineLatex,
    },
];
