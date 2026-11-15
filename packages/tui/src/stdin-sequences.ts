/**
 * Where one terminal input sequence ends: CSI, OSC, DCS, APC, SS3, old- and
 * SGR-style mouse, and meta keys. Used to cut buffered stdin into whole
 * sequences.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

export const ESC = "\x1b";

/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
    if (!data.startsWith(ESC)) {
        return "not-escape";
    }

    if (data.length === 1) {
        return "incomplete";
    }

    const afterEsc = data.slice(1);

    // CSI sequences: ESC [
    if (afterEsc.startsWith("[")) {
        // Check for old-style mouse sequence: ESC[M + 3 bytes
        if (afterEsc.startsWith("[M")) {
            // Old-style mouse needs ESC[M + 3 bytes = 6 total
            return data.length >= 6 ? "complete" : "incomplete";
        }
        return isCompleteCsiSequence(data);
    }

    // OSC sequences: ESC ]
    if (afterEsc.startsWith("]")) {
        return isCompleteOscSequence(data);
    }

    // DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
    if (afterEsc.startsWith("P")) {
        return isCompleteDcsSequence(data);
    }

    // APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
    if (afterEsc.startsWith("_")) {
        return isCompleteApcSequence(data);
    }

    // SS3 sequences: ESC O
    if (afterEsc.startsWith("O")) {
        // ESC O followed by a single character
        return afterEsc.length >= 2 ? "complete" : "incomplete";
    }

    // Meta key sequences: ESC followed by a single character
    if (afterEsc.length === 1) {
        return "complete";
    }

    // Unknown escape sequence - treat as complete
    return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
    if (!data.startsWith(`${ESC}[`)) {
        return "complete";
    }

    // Need at least ESC [ and one more character
    if (data.length < 3) {
        return "incomplete";
    }

    const payload = data.slice(2);

    // CSI sequences end with a byte in the range 0x40-0x7E (@-~)
    // This includes all letters and several special characters
    const lastChar = payload[payload.length - 1];
    const lastCharCode = lastChar.charCodeAt(0);

    if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
        // Special handling for SGR mouse sequences
        // Format: ESC[<B;X;Ym or ESC[<B;X;YM
        if (payload.startsWith("<")) {
            // Must have format: <digits;digits;digits[Mm]
            const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
            if (mouseMatch) {
                return "complete";
            }
            // If it ends with M or m but doesn't match the pattern, still incomplete
            if (lastChar === "M" || lastChar === "m") {
                // Check if we have the right structure
                const parts = payload.slice(1, -1).split(";");
                if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
                    return "complete";
                }
            }

            return "incomplete";
        }

        return "complete";
    }

    return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
    if (!data.startsWith(`${ESC}]`)) {
        return "complete";
    }

    // OSC sequences end with ST (ESC \) or BEL (\x07)
    if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
        return "complete";
    }

    return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
    if (!data.startsWith(`${ESC}P`)) {
        return "complete";
    }

    // DCS sequences end with ST (ESC \)
    if (data.endsWith(`${ESC}\\`)) {
        return "complete";
    }

    return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
    if (!data.startsWith(`${ESC}_`)) {
        return "complete";
    }

    // APC sequences end with ST (ESC \)
    if (data.endsWith(`${ESC}\\`)) {
        return "complete";
    }

    return "incomplete";
}

/** Bytes after ESC ESC that start a new escape sequence (CSI, OSC, SS3, DCS, APC). */
const SEQUENCE_INTRODUCERS = new Set(["[", "]", "O", "P", "_"]);

/** Split accumulated buffer into complete sequences, and the incomplete tail. */
export function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
    const sequences: string[] = [];
    let pos = 0;
    while (pos < buffer.length) {
        const remaining = buffer.slice(pos);
        if (!remaining.startsWith(ESC)) {
            // Not an escape sequence - take a single character
            sequences.push(remaining[0]!);
            pos++;
            continue;
        }
        const length = escapeSequenceLength(remaining);
        if (length === undefined) return { sequences, remainder: remaining };
        sequences.push(remaining.slice(0, length));
        pos += length;
    }
    return { sequences, remainder: "" };
}

/** Length of the escape sequence `remaining` starts with, or undefined while it is incomplete. */
function escapeSequenceLength(remaining: string): number | undefined {
    for (let seqEnd = 1; seqEnd <= remaining.length; seqEnd++) {
        const candidate = remaining.slice(0, seqEnd);
        if (isCompleteSequence(candidate) === "incomplete") continue;
        // WezTerm with enable_kitty_keyboard sends the Escape key press as a
        // raw '\x1b' byte (simple text path in encode_kitty, ignoring
        // DISAMBIGUATE_ESCAPE_CODES) and the release as a full Kitty CSI-u
        // sequence. These arrive concatenated as '\x1b\x1b[27;...u'.
        // The buffer would normally treat '\x1b\x1b' as a complete meta-key
        // sequence (ESC + single char), leaving '[27;...u' to be typed as
        // plain text. If the character immediately following '\x1b\x1b'
        // would begin a new escape sequence, emit only the first ESC and
        // restart from the second.
        if (candidate === "\x1b\x1b" && SEQUENCE_INTRODUCERS.has(remaining[seqEnd] ?? "")) return 1;
        return seqEnd;
    }
    return undefined;
}

/** An unmodified Kitty CSI-u press of a printable key: its codepoint. */
export function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
    const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
    if (!match) return undefined;
    const codepoint = parseInt(match[1]!, 10);
    return codepoint >= 32 ? codepoint : undefined;
}
