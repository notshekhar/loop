/**
 * matchesKey: does this input match a key identifier? Every key accepts its
 * Kitty CSI-u form; most also accept xterm modifyOtherKeys and one or more
 * legacy byte sequences, some of which mean different things depending on
 * whether the Kitty protocol is on.
 */
import {
    ARROW_CODEPOINTS,
    CODEPOINTS,
    FUNCTIONAL_CODEPOINTS,
    LEGACY_KEY_SEQUENCES,
    matchesLegacyModifierSequence,
    matchesLegacySequence,
    MODIFIERS,
    SYMBOL_KEYS,
    type LegacyModifierKey,
} from "./codes";
import { parseKeyId, type KeyId, type ParsedKeyId } from "./key-id";
import { isKittyProtocolActive } from "./protocol";
import {
    matchesKittySequence,
    matchesModifyOtherKeys,
    matchesPrintableModifyOtherKeys,
    matchesRawBackspace,
} from "./sequences";

/** `modifier` is the MODIFIERS bitmask of the key id being matched. */
type KeyMatcher = (data: string, modifier: number) => boolean;

const { shift: SHIFT, alt: ALT, ctrl: CTRL } = MODIFIERS;

/**
 * Match input data against a key identifier string.
 *
 * Supported key identifiers:
 * - Single keys: "escape", "tab", "enter", "backspace", "delete", "home", "end", "space"
 * - Arrow keys: "up", "down", "left", "right"
 * - Ctrl combinations: "ctrl+c", "ctrl+z", etc.
 * - Shift combinations: "shift+tab", "shift+enter"
 * - Alt combinations: "alt+enter", "alt+backspace"
 * - Super combinations: "super+k", "super+enter"
 * - Combined modifiers: "shift+ctrl+p", "ctrl+alt+x", "ctrl+super+k"
 *
 * Use the Key helper for autocomplete: Key.ctrl("c"), Key.escape, Key.ctrlShift("p"), Key.super("k")
 *
 * @param data - Raw input data from terminal
 * @param keyId - Key identifier (e.g., "ctrl+c", "escape", Key.ctrl("c"))
 */
export function matchesKey(data: string, keyId: KeyId): boolean {
    const parsed = parseKeyId(keyId);
    if (!parsed) return false;
    const modifier = modifierBits(parsed);
    const named = NAMED_KEYS.get(parsed.key);
    if (named) return named(data, modifier);
    if (isPrintableKey(parsed.key)) return matchesPrintableKey(data, parsed.key, modifier);
    return false;
}

function modifierBits(parsed: ParsedKeyId): number {
    let modifier = 0;
    if (parsed.shift) modifier |= MODIFIERS.shift;
    if (parsed.alt) modifier |= MODIFIERS.alt;
    if (parsed.ctrl) modifier |= MODIFIERS.ctrl;
    if (parsed.super) modifier |= MODIFIERS.super;
    return modifier;
}

/** The two encodings that can carry any modifier: Kitty CSI-u and xterm modifyOtherKeys. */
function matchesEncoded(data: string, codepoint: number, modifier: number): boolean {
    return matchesKittySequence(data, codepoint, modifier) || matchesModifyOtherKeys(data, codepoint, modifier);
}

const matchesEscape: KeyMatcher = (data, modifier) =>
    modifier === 0 && (data === "\x1b" || matchesEncoded(data, CODEPOINTS.escape, 0));

const matchesSpace: KeyMatcher = (data, modifier) => {
    if (!isKittyProtocolActive()) {
        if (modifier === CTRL && data === "\x00") return true;
        if (modifier === ALT && data === "\x1b ") return true;
    }
    if (modifier === 0) return data === " " || matchesEncoded(data, CODEPOINTS.space, 0);
    return matchesEncoded(data, CODEPOINTS.space, modifier);
};

const matchesTab: KeyMatcher = (data, modifier) => {
    if (modifier === SHIFT) return data === "\x1b[Z" || matchesEncoded(data, CODEPOINTS.tab, SHIFT);
    if (modifier === 0) return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
    return matchesEncoded(data, CODEPOINTS.tab, modifier);
};

/** Enter or numpad Enter, in CSI-u. */
function matchesKittyEnter(data: string, modifier: number): boolean {
    return (
        matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
        matchesKittySequence(data, CODEPOINTS.kpEnter, modifier)
    );
}

const matchesEnter: KeyMatcher = (data, modifier) => {
    const kitty = isKittyProtocolActive();
    if (modifier === SHIFT || modifier === ALT) {
        if (matchesKittyEnter(data, modifier) || matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier)) return true;
        // With the Kitty protocol on, legacy bytes for shift+enter are custom
        // terminal mappings: \x1b\r = Kitty's "map shift+enter send_text all
        // \e\r", \n = Ghostty's "keybind = shift+enter=text:\n". Without it,
        // \x1b\r is alt+enter (with it, alt+enter comes as CSI u).
        if (modifier === SHIFT) return kitty && (data === "\x1b\r" || data === "\n");
        return !kitty && data === "\x1b\r";
    }
    if (modifier === 0) {
        return (
            data === "\r" ||
            (!kitty && data === "\n") ||
            data === "\x1bOM" || // SS3 M (numpad enter in some terminals)
            matchesKittyEnter(data, 0)
        );
    }
    return matchesKittyEnter(data, modifier) || matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier);
};

const matchesBackspace: KeyMatcher = (data, modifier) => {
    if (modifier === ALT && (data === "\x1b\x7f" || data === "\x1b\b")) return true;
    // Legacy raw 0x08 is ambiguous: it can be Ctrl+Backspace on Windows
    // Terminal or plain Backspace on other terminals, while also overlapping
    // with Ctrl+H.
    if ((modifier === CTRL || modifier === 0) && matchesRawBackspace(data, modifier)) return true;
    return matchesEncoded(data, CODEPOINTS.backspace, modifier);
};

/**
 * Keys with an unmodified legacy sequence, shift/ctrl legacy variants, and a
 * Kitty functional codepoint: insert, delete, home, end, the page keys, and
 * (with extra alt/ctrl forms layered on top) the arrows.
 */
function legacyKeyMatcher(name: LegacyModifierKey, codepoint: number): KeyMatcher {
    return (data, modifier) => {
        if (modifier === 0) {
            return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[name]) || matchesKittySequence(data, codepoint, 0);
        }
        return matchesLegacyModifierSequence(data, name, modifier) || matchesKittySequence(data, codepoint, modifier);
    };
}

const matchesClear: KeyMatcher = (data, modifier) =>
    modifier === 0
        ? matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear)
        : matchesLegacyModifierSequence(data, "clear", modifier);

/** Up/down: legacy alt+arrow arrives as ESC + p / n. */
function verticalArrowMatcher(name: "up" | "down", altLegacy: string): KeyMatcher {
    const codepoint = ARROW_CODEPOINTS[name];
    const base = legacyKeyMatcher(name, codepoint);
    return (data, modifier) => {
        if (modifier === ALT) return data === altLegacy || matchesKittySequence(data, codepoint, ALT);
        return base(data, modifier);
    };
}

/**
 * Left/right: word-jump keys, so alt and ctrl each have several legacy forms —
 * xterm's CSI 1;3 / 1;5, ESC + B / F (only without Kitty, where it can't be
 * shift+letter), and readline's ESC + b / f.
 */
function horizontalArrowMatcher(name: "left" | "right", final: "D" | "C", wordLetter: "b" | "f"): KeyMatcher {
    const codepoint = ARROW_CODEPOINTS[name];
    const base = legacyKeyMatcher(name, codepoint);
    return (data, modifier) => {
        if (modifier === ALT) {
            return (
                data === `\x1b[1;3${final}` ||
                (!isKittyProtocolActive() && data === `\x1b${wordLetter.toUpperCase()}`) ||
                data === `\x1b${wordLetter}` ||
                matchesKittySequence(data, codepoint, ALT)
            );
        }
        if (modifier === CTRL && data === `\x1b[1;5${final}`) return true;
        return base(data, modifier);
    };
}

function functionKeyMatcher(name: keyof typeof LEGACY_KEY_SEQUENCES): KeyMatcher {
    return (data, modifier) => modifier === 0 && matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[name]);
}

const FUNCTION_KEYS = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"] as const;

/** Key names are matched lower-cased (parseKeyId lower-cases the id). */
const NAMED_KEYS = new Map<string, KeyMatcher>([
    ["escape", matchesEscape],
    ["esc", matchesEscape],
    ["space", matchesSpace],
    ["tab", matchesTab],
    ["enter", matchesEnter],
    ["return", matchesEnter],
    ["backspace", matchesBackspace],
    ["insert", legacyKeyMatcher("insert", FUNCTIONAL_CODEPOINTS.insert)],
    ["delete", legacyKeyMatcher("delete", FUNCTIONAL_CODEPOINTS.delete)],
    ["clear", matchesClear],
    ["home", legacyKeyMatcher("home", FUNCTIONAL_CODEPOINTS.home)],
    ["end", legacyKeyMatcher("end", FUNCTIONAL_CODEPOINTS.end)],
    ["pageup", legacyKeyMatcher("pageUp", FUNCTIONAL_CODEPOINTS.pageUp)],
    ["pagedown", legacyKeyMatcher("pageDown", FUNCTIONAL_CODEPOINTS.pageDown)],
    ["up", verticalArrowMatcher("up", "\x1bp")],
    ["down", verticalArrowMatcher("down", "\x1bn")],
    ["left", horizontalArrowMatcher("left", "D", "b")],
    ["right", horizontalArrowMatcher("right", "C", "f")],
    ...FUNCTION_KEYS.map((name) => [name, functionKeyMatcher(name)] as const),
]);

const isLetterKey = (key: string) => key >= "a" && key <= "z";
const isDigitKey = (key: string) => key >= "0" && key <= "9";

function isPrintableKey(key: string): boolean {
    return key.length === 1 && (isLetterKey(key) || isDigitKey(key) || SYMBOL_KEYS.has(key));
}

/**
 * Get the control character for a key.
 * Uses the universal formula: code & 0x1f (mask to lower 5 bits)
 *
 * Works for:
 * - Letters a-z → 1-26
 * - Symbols [\]_ → 27, 28, 29, 31
 * - Also maps - to same as _ (same physical key on US keyboards)
 */
function rawCtrlChar(key: string): string | null {
    const char = key.toLowerCase();
    const code = char.charCodeAt(0);
    if ((code >= 97 && code <= 122) || char === "[" || char === "\\" || char === "]" || char === "_") {
        return String.fromCharCode(code & 0x1f);
    }
    // Handle - as _ (same physical key on US keyboards)
    if (char === "-") {
        return String.fromCharCode(31); // Same as Ctrl+_
    }
    return null;
}

/** A letter, digit or symbol key — with its legacy forms checked before the encoded ones. */
function matchesPrintableKey(data: string, key: string, modifier: number): boolean {
    const codepoint = key.charCodeAt(0);
    const rawCtrl = rawCtrlChar(key);
    if (matchesLegacyPrintable(data, key, modifier, rawCtrl)) return true;
    // Check both raw char and Kitty sequence (needed for release events)
    if (modifier === 0) return data === key || matchesKittySequence(data, codepoint, 0);
    return (
        matchesKittySequence(data, codepoint, modifier) || matchesPrintableModifyOtherKeys(data, codepoint, modifier)
    );
}

function matchesLegacyPrintable(data: string, key: string, modifier: number, rawCtrl: string | null): boolean {
    const kitty = isKittyProtocolActive();
    // ctrl+alt+key is ESC followed by the control character. If that does not
    // match, the CSI-u and modifyOtherKeys forms from tmux still get a chance.
    if (modifier === CTRL + ALT && !kitty && rawCtrl) return data === `\x1b${rawCtrl}`;
    // alt+printable key is ESC followed by the key.
    if (modifier === ALT && !kitty) return data === `\x1b${key}`;
    // ctrl+key sends the control character.
    if (modifier === CTRL) return rawCtrl !== null && data === rawCtrl;
    // shift+letter produces uppercase.
    if (modifier === SHIFT) return isLetterKey(key) && data === key.toUpperCase();
    return false;
}
