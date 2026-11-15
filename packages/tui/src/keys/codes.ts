/** Codepoints, modifier bits and the legacy escape sequences terminals send for each key. */

export const SYMBOL_KEYS = new Set([
    "`",
    "-",
    "=",
    "[",
    "]",
    "\\",
    ";",
    "'",
    ",",
    ".",
    "/",
    "!",
    "@",
    "#",
    "$",
    "%",
    "^",
    "&",
    "*",
    "(",
    ")",
    "_",
    "+",
    "|",
    "~",
    "{",
    "}",
    ":",
    "<",
    ">",
    "?",
]);

export const MODIFIERS = {
    shift: 1,
    alt: 2,
    ctrl: 4,
    super: 8,
} as const;

export const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

export const CODEPOINTS = {
    escape: 27,
    tab: 9,
    enter: 13,
    space: 32,
    backspace: 127,
    kpEnter: 57414, // Numpad Enter (Kitty protocol)
} as const;

export const ARROW_CODEPOINTS = {
    up: -1,
    down: -2,
    right: -3,
    left: -4,
} as const;

export const FUNCTIONAL_CODEPOINTS = {
    delete: -10,
    insert: -11,
    pageUp: -12,
    pageDown: -13,
    home: -14,
    end: -15,
} as const;

const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
    [57399, 48], // KP_0 -> 0
    [57400, 49], // KP_1 -> 1
    [57401, 50], // KP_2 -> 2
    [57402, 51], // KP_3 -> 3
    [57403, 52], // KP_4 -> 4
    [57404, 53], // KP_5 -> 5
    [57405, 54], // KP_6 -> 6
    [57406, 55], // KP_7 -> 7
    [57407, 56], // KP_8 -> 8
    [57408, 57], // KP_9 -> 9
    [57409, 46], // KP_DECIMAL -> .
    [57410, 47], // KP_DIVIDE -> /
    [57411, 42], // KP_MULTIPLY -> *
    [57412, 45], // KP_SUBTRACT -> -
    [57413, 43], // KP_ADD -> +
    [57415, 61], // KP_EQUAL -> =
    [57416, 44], // KP_SEPARATOR -> ,
    [57417, ARROW_CODEPOINTS.left],
    [57418, ARROW_CODEPOINTS.right],
    [57419, ARROW_CODEPOINTS.up],
    [57420, ARROW_CODEPOINTS.down],
    [57421, FUNCTIONAL_CODEPOINTS.pageUp],
    [57422, FUNCTIONAL_CODEPOINTS.pageDown],
    [57423, FUNCTIONAL_CODEPOINTS.home],
    [57424, FUNCTIONAL_CODEPOINTS.end],
    [57425, FUNCTIONAL_CODEPOINTS.insert],
    [57426, FUNCTIONAL_CODEPOINTS.delete],
]);

export function normalizeKittyFunctionalCodepoint(codepoint: number): number {
    return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

export function normalizeShiftedLetterIdentityCodepoint(codepoint: number, modifier: number): number {
    const effectiveModifier = modifier & ~LOCK_MASK;
    if ((effectiveModifier & MODIFIERS.shift) !== 0 && codepoint >= 65 && codepoint <= 90) {
        return codepoint + 32;
    }
    return codepoint;
}

export const LEGACY_KEY_SEQUENCES = {
    up: ["\x1b[A", "\x1bOA"],
    down: ["\x1b[B", "\x1bOB"],
    right: ["\x1b[C", "\x1bOC"],
    left: ["\x1b[D", "\x1bOD"],
    home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
    end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
    insert: ["\x1b[2~"],
    delete: ["\x1b[3~"],
    pageUp: ["\x1b[5~", "\x1b[[5~"],
    pageDown: ["\x1b[6~", "\x1b[[6~"],
    clear: ["\x1b[E", "\x1bOE"],
    f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
    f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
    f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
    f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
    f5: ["\x1b[15~", "\x1b[[E"],
    f6: ["\x1b[17~"],
    f7: ["\x1b[18~"],
    f8: ["\x1b[19~"],
    f9: ["\x1b[20~"],
    f10: ["\x1b[21~"],
    f11: ["\x1b[23~"],
    f12: ["\x1b[24~"],
} as const;

const LEGACY_SHIFT_SEQUENCES = {
    up: ["\x1b[a"],
    down: ["\x1b[b"],
    right: ["\x1b[c"],
    left: ["\x1b[d"],
    clear: ["\x1b[e"],
    insert: ["\x1b[2$"],
    delete: ["\x1b[3$"],
    pageUp: ["\x1b[5$"],
    pageDown: ["\x1b[6$"],
    home: ["\x1b[7$"],
    end: ["\x1b[8$"],
} as const;

const LEGACY_CTRL_SEQUENCES = {
    up: ["\x1bOa"],
    down: ["\x1bOb"],
    right: ["\x1bOc"],
    left: ["\x1bOd"],
    clear: ["\x1bOe"],
    insert: ["\x1b[2^"],
    delete: ["\x1b[3^"],
    pageUp: ["\x1b[5^"],
    pageDown: ["\x1b[6^"],
    home: ["\x1b[7^"],
    end: ["\x1b[8^"],
} as const;

export type LegacyModifierKey = keyof typeof LEGACY_SHIFT_SEQUENCES;

export const matchesLegacySequence = (data: string, sequences: readonly string[]): boolean => sequences.includes(data);

export const matchesLegacyModifierSequence = (data: string, key: LegacyModifierKey, modifier: number): boolean => {
    if (modifier === MODIFIERS.shift) {
        return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
    }
    if (modifier === MODIFIERS.ctrl) {
        return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
    }
    return false;
};
