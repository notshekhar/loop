/** parseKey: the key identifier ("ctrl+c") for raw terminal input, or undefined. */
import {
    ARROW_CODEPOINTS,
    CODEPOINTS,
    FUNCTIONAL_CODEPOINTS,
    LOCK_MASK,
    MODIFIERS,
    normalizeKittyFunctionalCodepoint,
    normalizeShiftedLetterIdentityCodepoint,
    SYMBOL_KEYS,
} from "./codes";
import type { KeyId } from "./key-id";
import { isKittyProtocolActive } from "./protocol";
import { isWindowsTerminalSession, parseKittySequence, parseModifyOtherKeysSequence } from "./sequences";

export function parseKey(data: string): string | undefined {
    const kitty = parseKittySequence(data);
    if (kitty) return formatParsedKey(kitty.codepoint, kitty.modifier, kitty.baseLayoutKey);
    const modifyOtherKeys = parseModifyOtherKeysSequence(data);
    if (modifyOtherKeys) return formatParsedKey(modifyOtherKeys.codepoint, modifyOtherKeys.modifier);
    return parseLegacyKey(data);
}

/** Key names by codepoint (after functional-key normalisation). */
const NAMED_CODEPOINTS = new Map<number, string>([
    [CODEPOINTS.escape, "escape"],
    [CODEPOINTS.tab, "tab"],
    [CODEPOINTS.enter, "enter"],
    [CODEPOINTS.kpEnter, "enter"],
    [CODEPOINTS.space, "space"],
    [CODEPOINTS.backspace, "backspace"],
    [FUNCTIONAL_CODEPOINTS.delete, "delete"],
    [FUNCTIONAL_CODEPOINTS.insert, "insert"],
    [FUNCTIONAL_CODEPOINTS.home, "home"],
    [FUNCTIONAL_CODEPOINTS.end, "end"],
    [FUNCTIONAL_CODEPOINTS.pageUp, "pageUp"],
    [FUNCTIONAL_CODEPOINTS.pageDown, "pageDown"],
    [ARROW_CODEPOINTS.up, "up"],
    [ARROW_CODEPOINTS.down, "down"],
    [ARROW_CODEPOINTS.left, "left"],
    [ARROW_CODEPOINTS.right, "right"],
]);

const isLatinLetterCode = (cp: number) => cp >= 97 && cp <= 122; // a-z
const isDigitCode = (cp: number) => cp >= 48 && cp <= 57; // 0-9
const isSymbolCode = (cp: number) => SYMBOL_KEYS.has(String.fromCharCode(cp));

function formatParsedKey(codepoint: number, modifier: number, baseLayoutKey?: number): string | undefined {
    const identityCodepoint = normalizeShiftedLetterIdentityCodepoint(
        normalizeKittyFunctionalCodepoint(codepoint),
        modifier,
    );
    // Use base layout key only when codepoint is not a recognized Latin
    // letter (a-z), digit (0-9), or symbol (/, -, [, ;, etc.). For those,
    // the codepoint is authoritative regardless of physical key position.
    // This prevents remapped layouts (Dvorak, Colemak, xremap, etc.) from
    // reporting the wrong key name based on the QWERTY physical position.
    const recognized =
        isLatinLetterCode(identityCodepoint) || isDigitCode(identityCodepoint) || isSymbolCode(identityCodepoint);
    const effective = recognized ? identityCodepoint : (baseLayoutKey ?? identityCodepoint);
    const keyName =
        NAMED_CODEPOINTS.get(effective) ??
        (isDigitCode(effective) || isLatinLetterCode(effective) || isSymbolCode(effective)
            ? String.fromCharCode(effective)
            : undefined);
    if (!keyName) return undefined;
    return formatKeyNameWithModifiers(keyName, modifier);
}

function formatKeyNameWithModifiers(keyName: string, modifier: number): string | undefined {
    const mods: string[] = [];
    const effectiveMod = modifier & ~LOCK_MASK;
    const supportedModifierMask = MODIFIERS.shift | MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.super;
    if ((effectiveMod & ~supportedModifierMask) !== 0) return undefined;
    if (effectiveMod & MODIFIERS.shift) mods.push("shift");
    if (effectiveMod & MODIFIERS.ctrl) mods.push("ctrl");
    if (effectiveMod & MODIFIERS.alt) mods.push("alt");
    if (effectiveMod & MODIFIERS.super) mods.push("super");
    return mods.length > 0 ? `${mods.join("+")}+${keyName}` : keyName;
}

const LEGACY_SEQUENCE_KEY_IDS: Record<string, KeyId> = {
    "\x1bOA": "up",
    "\x1bOB": "down",
    "\x1bOC": "right",
    "\x1bOD": "left",
    "\x1bOH": "home",
    "\x1bOF": "end",
    "\x1b[E": "clear",
    "\x1bOE": "clear",
    "\x1bOe": "ctrl+clear",
    "\x1b[e": "shift+clear",
    "\x1b[2~": "insert",
    "\x1b[2$": "shift+insert",
    "\x1b[2^": "ctrl+insert",
    "\x1b[3$": "shift+delete",
    "\x1b[3^": "ctrl+delete",
    "\x1b[[5~": "pageUp",
    "\x1b[[6~": "pageDown",
    "\x1b[a": "shift+up",
    "\x1b[b": "shift+down",
    "\x1b[c": "shift+right",
    "\x1b[d": "shift+left",
    "\x1bOa": "ctrl+up",
    "\x1bOb": "ctrl+down",
    "\x1bOc": "ctrl+right",
    "\x1bOd": "ctrl+left",
    "\x1b[5$": "shift+pageUp",
    "\x1b[6$": "shift+pageDown",
    "\x1b[7$": "shift+home",
    "\x1b[8$": "shift+end",
    "\x1b[5^": "ctrl+pageUp",
    "\x1b[6^": "ctrl+pageDown",
    "\x1b[7^": "ctrl+home",
    "\x1b[8^": "ctrl+end",
    "\x1bOP": "f1",
    "\x1bOQ": "f2",
    "\x1bOR": "f3",
    "\x1bOS": "f4",
    "\x1b[11~": "f1",
    "\x1b[12~": "f2",
    "\x1b[13~": "f3",
    "\x1b[14~": "f4",
    "\x1b[[A": "f1",
    "\x1b[[B": "f2",
    "\x1b[[C": "f3",
    "\x1b[[D": "f4",
    "\x1b[[E": "f5",
    "\x1b[15~": "f5",
    "\x1b[17~": "f6",
    "\x1b[18~": "f7",
    "\x1b[19~": "f8",
    "\x1b[20~": "f9",
    "\x1b[21~": "f10",
    "\x1b[23~": "f11",
    "\x1b[24~": "f12",
    "\x1bb": "alt+left",
    "\x1bf": "alt+right",
    "\x1bp": "alt+up",
    "\x1bn": "alt+down",
} as const;

/** Single bytes and ESC pairs with one meaning whatever the protocol. */
const FIXED_LEGACY_KEYS: Record<string, string> = {
    "\x1b": "escape",
    "\x1c": "ctrl+\\",
    "\x1d": "ctrl+]",
    "\x1f": "ctrl+-",
    "\x1b\x1b": "ctrl+alt+[",
    "\x1b\x1c": "ctrl+alt+\\",
    "\x1b\x1d": "ctrl+alt+]",
    "\x1b\x1f": "ctrl+alt+-",
    "\t": "tab",
    "\r": "enter",
    "\x1bOM": "enter",
    "\x00": "ctrl+space",
    " ": "space",
    "\x7f": "backspace",
    "\x1b[Z": "shift+tab",
    "\x1b\x7f": "alt+backspace",
    "\x1b\b": "alt+backspace",
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1b[3~": "delete",
    "\x1b[5~": "pageUp",
    "\x1b[6~": "pageDown",
};

/** Bytes that are only these keys when the Kitty protocol is off. */
const LEGACY_ONLY_KEYS: Record<string, string> = {
    "\n": "enter",
    "\x1b\r": "alt+enter",
    "\x1b ": "alt+space",
    "\x1bB": "alt+left",
    "\x1bF": "alt+right",
};

/**
 * Mode-aware legacy sequences. With the Kitty protocol on, ambiguous bytes
 * are custom terminal mappings: \x1b\r = shift+enter (Kitty mapping, not
 * alt+enter), \n = shift+enter (Ghostty mapping).
 */
function parseLegacyKey(data: string): string | undefined {
    const kitty = isKittyProtocolActive();
    if (kitty && (data === "\x1b\r" || data === "\n")) return "shift+enter";
    if (Object.hasOwn(LEGACY_SEQUENCE_KEY_IDS, data)) return LEGACY_SEQUENCE_KEY_IDS[data];
    if (Object.hasOwn(FIXED_LEGACY_KEYS, data)) return FIXED_LEGACY_KEYS[data];
    if (data === "\x08") return isWindowsTerminalSession() ? "ctrl+backspace" : "backspace";
    if (!kitty && Object.hasOwn(LEGACY_ONLY_KEYS, data)) return LEGACY_ONLY_KEYS[data];
    if (!kitty && data.length === 2 && data[0] === "\x1b") {
        const altKey = parseEscPrefixedKey(data.charCodeAt(1));
        if (altKey) return altKey;
    }
    return data.length === 1 ? parseSingleByteKey(data) : undefined;
}

/** ESC + a control byte is ctrl+alt+letter; ESC + a printable key is alt+key. */
function parseEscPrefixedKey(code: number): string | undefined {
    if (code >= 1 && code <= 26) return `ctrl+alt+${String.fromCharCode(code + 96)}`;
    if (isLatinLetterCode(code) || isDigitCode(code) || isSymbolCode(code)) return `alt+${String.fromCharCode(code)}`;
    return undefined;
}

/** Raw ctrl+letter, or a printable ASCII character as itself. */
function parseSingleByteKey(data: string): string | undefined {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
    if (code >= 32 && code <= 126) return data;
    return undefined;
}
