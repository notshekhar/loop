/**
 * The encoded key sequences terminals send: Kitty CSI-u (and its arrow /
 * functional forms), xterm modifyOtherKeys, and the raw backspace byte.
 */
import {
    FUNCTIONAL_CODEPOINTS,
    LOCK_MASK,
    MODIFIERS,
    normalizeKittyFunctionalCodepoint,
    normalizeShiftedLetterIdentityCodepoint,
    SYMBOL_KEYS,
} from "./codes";

/**
 * CSI u format with alternate keys (flag 4):
 *   \x1b[<codepoint>u
 *   \x1b[<codepoint>;<mod>u
 *   \x1b[<codepoint>;<mod>:<event>u
 *   \x1b[<codepoint>:<shifted>;<mod>u
 *   \x1b[<codepoint>:<shifted>:<base>;<mod>u
 *   \x1b[<codepoint>::<base>;<mod>u (no shifted key, only base)
 * With flag 2, the event type follows the modifier: 1=press, 2=repeat, 3=release.
 */
export const KITTY_CSI_U_REGEX = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;

/**
 * Event types from Kitty keyboard protocol (flag 2)
 * 1 = key press, 2 = key repeat, 3 = key release
 */
export type KeyEventType = "press" | "repeat" | "release";

interface ParsedKittySequence {
    codepoint: number;
    shiftedKey?: number; // Shifted version of the key (when shift is pressed)
    baseLayoutKey?: number; // Key in standard PC-101 layout (for non-Latin layouts)
    modifier: number;
    eventType: KeyEventType;
}

interface ParsedModifyOtherKeysSequence {
    codepoint: number;
    modifier: number;
}

/** Final bytes of the Kitty sequences that can carry an event type (flag 2). */
const EVENT_TYPE_TERMINATORS = ["u", "~", "A", "B", "C", "D", "H", "F"];

/**
 * Whether `data` is a Kitty event of the given type — `:<type>` right before
 * the sequence's final byte, e.g. \x1b[<codepoint>;<modifier>:3u.
 *
 * Bracketed paste is never a key event, even when it contains such a pattern
 * (bluetooth MAC addresses like "90:62:3F:A5"). Terminal.ts re-wraps paste
 * content with bracketed paste markers before passing it on, so pasted data
 * always contains \x1b[200~.
 */
function isKittyEventType(data: string, type: "2" | "3"): boolean {
    if (data.includes("\x1b[200~")) return false;
    return EVENT_TYPE_TERMINATORS.some((end) => data.includes(`:${type}${end}`));
}

/** A key release. Only meaningful when Kitty keyboard protocol with flag 2 is active. */
export function isKeyRelease(data: string): boolean {
    return isKittyEventType(data, "3");
}

/** A key repeat. Only meaningful when Kitty keyboard protocol with flag 2 is active. */
export function isKeyRepeat(data: string): boolean {
    return isKittyEventType(data, "2");
}

function parseEventType(eventTypeStr: string | undefined): KeyEventType {
    if (!eventTypeStr) return "press";
    const eventType = parseInt(eventTypeStr, 10);
    if (eventType === 2) return "repeat";
    if (eventType === 3) return "release";
    return "press";
}

export function parseKittySequence(data: string): ParsedKittySequence | null {
    const csiUMatch = data.match(KITTY_CSI_U_REGEX);
    if (csiUMatch) {
        const codepoint = parseInt(csiUMatch[1]!, 10);
        const shiftedKey = csiUMatch[2] && csiUMatch[2].length > 0 ? parseInt(csiUMatch[2], 10) : undefined;
        const baseLayoutKey = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : undefined;
        const modValue = csiUMatch[4] ? parseInt(csiUMatch[4], 10) : 1;
        const eventType = parseEventType(csiUMatch[5]);
        return { codepoint, shiftedKey, baseLayoutKey, modifier: modValue - 1, eventType };
    }

    // Arrow keys with modifier: \x1b[1;<mod>A/B/C/D or \x1b[1;<mod>:<event>A/B/C/D
    const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
    if (arrowMatch) {
        const modValue = parseInt(arrowMatch[1]!, 10);
        const eventType = parseEventType(arrowMatch[2]);
        const arrowCodes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
        return { codepoint: arrowCodes[arrowMatch[3]!]!, modifier: modValue - 1, eventType };
    }

    // Functional keys: \x1b[<num>~ or \x1b[<num>;<mod>~ or \x1b[<num>;<mod>:<event>~
    const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
    if (funcMatch) {
        const keyNum = parseInt(funcMatch[1]!, 10);
        const modValue = funcMatch[2] ? parseInt(funcMatch[2], 10) : 1;
        const eventType = parseEventType(funcMatch[3]);
        const funcCodes: Record<number, number> = {
            2: FUNCTIONAL_CODEPOINTS.insert,
            3: FUNCTIONAL_CODEPOINTS.delete,
            5: FUNCTIONAL_CODEPOINTS.pageUp,
            6: FUNCTIONAL_CODEPOINTS.pageDown,
            7: FUNCTIONAL_CODEPOINTS.home,
            8: FUNCTIONAL_CODEPOINTS.end,
        };
        const codepoint = funcCodes[keyNum];
        if (codepoint !== undefined) {
            return { codepoint, modifier: modValue - 1, eventType };
        }
    }

    // Home/End with modifier: \x1b[1;<mod>H/F or \x1b[1;<mod>:<event>H/F
    const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
    if (homeEndMatch) {
        const modValue = parseInt(homeEndMatch[1]!, 10);
        const eventType = parseEventType(homeEndMatch[2]);
        const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
        return { codepoint, modifier: modValue - 1, eventType };
    }

    return null;
}

export function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
    const parsed = parseKittySequence(data);
    if (!parsed) return false;
    const actualMod = parsed.modifier & ~LOCK_MASK;
    const expectedMod = expectedModifier & ~LOCK_MASK;

    // Check if modifiers match
    if (actualMod !== expectedMod) return false;

    const normalizedCodepoint = normalizeShiftedLetterIdentityCodepoint(
        normalizeKittyFunctionalCodepoint(parsed.codepoint),
        parsed.modifier,
    );
    const normalizedExpectedCodepoint = normalizeShiftedLetterIdentityCodepoint(
        normalizeKittyFunctionalCodepoint(expectedCodepoint),
        expectedModifier,
    );

    // Primary match: codepoint matches directly after normalizing functional keys
    if (normalizedCodepoint === normalizedExpectedCodepoint) return true;

    // Alternate match: use base layout key for non-Latin keyboard layouts.
    // This allows Ctrl+С (Cyrillic) to match Ctrl+c (Latin) when terminal reports
    // the base layout key (the key in standard PC-101 layout).
    //
    // Only fall back to base layout key when the codepoint is NOT already a
    // recognized Latin letter (a-z) or symbol (e.g., /, -, [, ;, etc.).
    // When the codepoint is a recognized key, it is authoritative regardless
    // of physical key position. This prevents remapped layouts (Dvorak, Colemak,
    // xremap, etc.) from causing false matches: both letters and symbols move
    // to different physical positions, so Ctrl+K could falsely match Ctrl+V
    // (letter remapping) and Ctrl+/ could falsely match Ctrl+[ (symbol remapping)
    // if the base layout key were always considered.
    if (parsed.baseLayoutKey !== undefined && parsed.baseLayoutKey === expectedCodepoint) {
        const cp = normalizedCodepoint;
        const isLatinLetter = cp >= 97 && cp <= 122; // a-z
        const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(cp));
        if (!isLatinLetter && !isKnownSymbol) return true;
    }

    return false;
}

export function parseModifyOtherKeysSequence(data: string): ParsedModifyOtherKeysSequence | null {
    const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
    if (!match) return null;
    const modValue = parseInt(match[1]!, 10);
    const codepoint = parseInt(match[2]!, 10);
    return { codepoint, modifier: modValue - 1 };
}

/**
 * Match xterm modifyOtherKeys format: CSI 27 ; modifiers ; keycode ~
 * This is used by terminals when Kitty protocol is not enabled.
 * Modifier values are 1-indexed: 2=shift, 3=alt, 5=ctrl, etc.
 */
export function matchesModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
    const parsed = parseModifyOtherKeysSequence(data);
    if (!parsed) return false;
    return parsed.codepoint === expectedKeycode && parsed.modifier === expectedModifier;
}

export function isWindowsTerminalSession(): boolean {
    return (
        Boolean(process.env.WT_SESSION) &&
        !process.env.SSH_CONNECTION &&
        !process.env.SSH_CLIENT &&
        !process.env.SSH_TTY
    );
}

/**
 * Raw 0x08 (BS) is ambiguous in legacy terminals.
 *
 * - Windows Terminal uses it for Ctrl+Backspace.
 * - Some legacy terminals and tmux setups send it for plain Backspace.
 *
 * Prefer explicit Kitty / CSI-u / modifyOtherKeys sequences whenever they are
 * available. Fall back to a Windows Terminal heuristic only for raw BS bytes.
 */
export function matchesRawBackspace(data: string, expectedModifier: number): boolean {
    if (data === "\x7f") return expectedModifier === 0;
    if (data !== "\x08") return false;
    return isWindowsTerminalSession() ? expectedModifier === MODIFIERS.ctrl : expectedModifier === 0;
}

export function matchesPrintableModifyOtherKeys(
    data: string,
    expectedKeycode: number,
    expectedModifier: number,
): boolean {
    if (expectedModifier === 0) return false;
    const parsed = parseModifyOtherKeysSequence(data);
    if (!parsed || parsed.modifier !== expectedModifier) return false;
    return (
        normalizeShiftedLetterIdentityCodepoint(parsed.codepoint, parsed.modifier) ===
        normalizeShiftedLetterIdentityCodepoint(expectedKeycode, expectedModifier)
    );
}
