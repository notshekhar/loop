import type { Token } from "marked";

/** While streaming, hide a closing fence that is still arriving (e.g. "``" of "```"). */
export function trimPartialClosingFences(tokens: readonly Token[]): void {
    const token = tokens[tokens.length - 1];
    if (token?.type === "list") {
        trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
        return;
    }
    if (token?.type === "blockquote") {
        trimPartialClosingFences(token.tokens ?? []);
        return;
    }
    if (token?.type !== "code") {
        return;
    }

    // Trim streamed partial closing fences so code blocks do not shrink/flicker
    // when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
    const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
    const lastLine = token.raw.split("\n").pop();
    if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
        return;
    }

    token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

/**
 * Block types that a following blank line SEALS: once one of these is closed
 * by a blank line, no amount of text arriving after it can change how it
 * lexed. That is what makes it safe to freeze the render of everything up to
 * that point while the rest of the document is still streaming in.
 *
 * `list` is missing on purpose. A blank line does not end a list —
 * "- a\n\n- b" lexes as ONE loose list, not two — so freezing across a
 * trailing list would re-lex "- b" as a fresh list and renumber an ordered
 * one from 1. Indented (unfenced) code has the same property, and `html` and
 * `def` are left out for the same class of reason.
 */
const SEALED_BLOCK_TYPES = new Set(["paragraph", "heading", "hr", "blockquote", "table"]);

/** A fenced code block whose closing fence has already arrived — sealed, unlike
 * an indented code block, which a later indented line extends. */
function isClosedFencedCode(token: Token): boolean {
    if (token.type !== "code") return false;
    const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
    if (!marker) return false; // indented code block
    const lastLine = token.raw.trimEnd().split("\n").pop() ?? "";
    return token.raw.trimEnd().length > marker.length && lastLine.startsWith(marker[0].repeat(marker.length));
}

/**
 * The last token that may be frozen, or -1 for none.
 *
 * Only blank-line boundaries qualify (a `space` token), and only when the
 * block in front of the blank line is sealed. The final two tokens are never
 * frozen: the last one is still growing, and a token's rendering is handed the
 * NEXT token's type, so the second-to-last one's output is not settled either.
 */
export function freezePoint(tokens: readonly Token[]): number {
    for (let i = tokens.length - 3; i >= 1; i--) {
        if (tokens[i].type !== "space") continue;
        const prev = tokens[i - 1];
        if (SEALED_BLOCK_TYPES.has(prev.type) || isClosedFencedCode(prev)) return i;
    }
    return -1;
}
