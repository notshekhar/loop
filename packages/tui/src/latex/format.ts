/** Inline formatting: scripts, fractions, roots, and the final whitespace/operator-spacing pass. */
import { SUBSCRIPTS, SUPERSCRIPTS } from "./symbols";

function replaceCharacters(value: string, replacements: Readonly<Record<string, string>>): string | undefined {
    let result = "";
    for (const character of value) {
        const replacement = replacements[character];
        if (replacement === undefined) {
            return undefined;
        }
        result += replacement;
    }
    return result;
}

export function formatScript(value: string, kind: "sub" | "sup"): string {
    value = value.trim();
    const replacements = kind === "sub" ? SUBSCRIPTS : SUPERSCRIPTS;
    const unicode = replaceCharacters(value.replace(/\s*([=+-])\s*/g, "$1"), replacements);
    if (unicode !== undefined) {
        return unicode;
    }

    const prefix = kind === "sub" ? "_" : "^";
    if (Array.from(value).length === 1 || (kind === "sub" && /^[A-Za-z]+$/.test(value))) {
        return `${prefix}${value}`;
    }
    return `${prefix}(${value})`;
}

export function formatFraction(numerator: string, denominator: string): string {
    numerator = numerator.trim();
    denominator = denominator.trim();
    const simpleNumerator = /^[\p{L}\p{N}.]+$/u.test(numerator);
    const simpleDenominator = /^[\p{N}.]+$/u.test(denominator) || Array.from(denominator).length === 1;
    return `${simpleNumerator ? numerator : `(${numerator})`}/${simpleDenominator ? denominator : `(${denominator})`}`;
}

export function formatRoot(value: string, symbol = "√"): string {
    value = value.trim();
    return /^[\p{L}\p{N}.]+$/u.test(value) ? `${symbol}${value}` : `${symbol}(${value})`;
}

export const NAMED_OPERATOR_START = "\u{f0004}";
export const NAMED_OPERATOR_END = "\u{f0005}";
const NAMED_OPERATOR_LEFT_SPACING_PATTERN = /(?<=[\p{L}\p{N})\]}\u{f0001}])\u{f0004}/gu;
const NAMED_OPERATOR_RIGHT_SPACING_PATTERN = /\u{f0005}(?=[\p{L}\p{N}√\u{f0000}])/gu;

export function normalizeOutput(value: string): string {
    return value
        .replace(NAMED_OPERATOR_LEFT_SPACING_PATTERN, " ")
        .replaceAll(NAMED_OPERATOR_START, "")
        .replace(NAMED_OPERATOR_RIGHT_SPACING_PATTERN, " ")
        .replaceAll(NAMED_OPERATOR_END, "")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
        .join("\n")
        .trim();
}
