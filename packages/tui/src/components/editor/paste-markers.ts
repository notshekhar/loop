/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
export const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
export const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/** A paste bigger than this is stored and shown as a marker instead of inline. */
const LARGE_PASTE_LINES = 10;
const LARGE_PASTE_CHARS = 1000;

/** Check if a segment is a paste marker (i.e. was merged by segmentWithMarkers). */
export function isPasteMarker(segment: string): boolean {
    return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste markers into single atomic segments.  This makes cursor
 * movement, deletion, word-wrap, etc. treat paste markers as single units.
 *
 * Only markers whose numeric ID exists in `validIds` are merged.
 */
export function segmentWithMarkers(
    text: string,
    baseSegmenter: Intl.Segmenter,
    validIds: Set<number>,
): Iterable<Intl.SegmentData> {
    if (validIds.size === 0 || !text.includes("[paste #")) {
        return baseSegmenter.segment(text);
    }
    const markers = findValidMarkers(text, validIds);
    if (markers.length === 0) {
        return baseSegmenter.segment(text);
    }

    const result: Intl.SegmentData[] = [];
    let markerIdx = 0;
    for (const seg of baseSegmenter.segment(text)) {
        // Skip past markers that are entirely before this segment.
        while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
            markerIdx++;
        }
        const marker = markers[markerIdx];
        if (!marker || seg.index < marker.start || seg.index >= marker.end) {
            result.push(seg);
        } else if (seg.index === marker.start) {
            // First grapheme of a marker stands for the whole marker; the rest are skipped.
            result.push({ segment: text.slice(marker.start, marker.end), index: marker.start, input: text });
        }
    }
    return result;
}

function findValidMarkers(text: string, validIds: Set<number>): Array<{ start: number; end: number }> {
    const markers: Array<{ start: number; end: number }> = [];
    for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
        if (!validIds.has(Number.parseInt(m[1]!, 10))) continue;
        markers.push({ start: m.index, end: m.index + m[0].length });
    }
    return markers;
}

/** Replace every marker with the text it stands for. */
export function expandPasteMarkers(text: string, pastes: Map<number, string>): string {
    let result = text;
    for (const [pasteId, pasteContent] of pastes) {
        const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
        result = result.replace(markerRegex, () => pasteContent);
    }
    return result;
}

/**
 * Forget paste `id` and close the gap: registry entries and markers with a
 * higher id move down by one ([paste #3] becomes [paste #2] when [paste #1]
 * is removed), in ascending id order regardless of marker order in the text.
 * Returns the renumbered lines.
 */
export function removePaste(lines: string[], pastes: Map<number, string>, id: number): string[] {
    pastes.delete(id);
    const higherIds = [...pastes.keys()].filter((other) => other > id).sort((a, b) => a - b);
    for (const other of higherIds) {
        pastes.set(other - 1, pastes.get(other)!);
        pastes.delete(other);
    }
    return lines.map((line) =>
        line.replace(PASTE_MARKER_REGEX, (fullMatch, idGroup, suffixGroup) => {
            const markerId = Number(idGroup);
            return markerId <= id ? fullMatch : `[paste #${markerId - 1}${suffixGroup}]`;
        }),
    );
}

/** The marker for a large paste, or undefined when the paste is small enough to insert inline. */
export function largePasteMarker(id: number, text: string): string | undefined {
    const lineCount = text.split("\n").length;
    if (lineCount > LARGE_PASTE_LINES) return `[paste #${id} +${lineCount} lines]`;
    if (text.length > LARGE_PASTE_CHARS) return `[paste #${id} ${text.length} chars]`;
    return undefined;
}

/**
 * Normalize text for editor storage:
 * - Normalize line endings (\r\n and \r -> \n)
 * - Expand tabs to 4 spaces
 */
export function normalizeText(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}

/**
 * Turn raw bracketed-paste bytes into text the editor can hold.
 *
 * Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
 * control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
 * (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
 * per-char filter preserves newlines instead of stripping ESC and leaking the
 * printable tail (e.g. "[106;5u") into the editor.
 */
export function cleanPastedText(raw: string): string {
    const decoded = raw.replace(/\x1b\[(\d+);5u/g, (match, code) => {
        const cp = Number(code);
        if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
        if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
        return match;
    });
    return normalizeText(decoded)
        .split("")
        .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
        .join("");
}
