/**
 * Moving rows instead of rewriting them.
 *
 * When a streamed reply grows by a line, every transcript row moves up by one,
 * so a row-by-row diff sees every row as changed and rewrites the whole
 * viewport. The terminal can move them itself: set a scroll region over the
 * rows that moved and scroll it, and only the rows that are really new still
 * need writing. Wheel scrolling is the same shift downwards.
 */

/** Rows a shift must save before it is used: its escape codes cost about as much as a short row. */
const MIN_ROWS_SAVED = 3;

/** Scroll rows `top..bottom` (inclusive, 0-based) by `lines`: positive moves content up, negative down. */
export interface ScrollShift {
    readonly top: number;
    readonly bottom: number;
    readonly lines: number;
}

/**
 * The shift that saves the most row writes between two screens of the same
 * size, or undefined when none saves at least MIN_ROWS_SAVED.
 */
export function findScrollShift(previous: readonly string[], next: readonly string[]): ScrollShift | undefined {
    const up = bestUpShift(previous, next);
    const down = bestUpShift([...previous].reverse(), [...next].reverse());
    const height = next.length;
    const mirroredDown = down && {
        gain: down.gain,
        shift: { top: height - 1 - down.shift.bottom, bottom: height - 1 - down.shift.top, lines: -down.shift.lines },
    };
    const best = !up ? mirroredDown : !mirroredDown || up.gain >= mirroredDown.gain ? up : mirroredDown;
    return best && best.gain >= MIN_ROWS_SAVED ? best.shift : undefined;
}

/** What the terminal shows after `shift` is applied to `previous`: moved rows, blanks where rows left. */
export function shiftedScreen(previous: readonly string[], shift: ScrollShift): string[] {
    const { top, bottom, lines } = shift;
    return previous.map((line, row) => {
        if (row < top || row > bottom) return line;
        const source = row + lines;
        return source >= top && source <= bottom ? (previous[source] ?? "") : "";
    });
}

/**
 * The bytes for `shift`. Attributes are reset first because the rows a scroll
 * opens are filled with the current background. Resetting the region homes the
 * cursor, which is fine: every row write after this positions itself.
 */
export function scrollShiftSequence(shift: ScrollShift): string {
    const scroll = shift.lines > 0 ? `\x1b[${shift.lines}S` : `\x1b[${-shift.lines}T`;
    return `\x1b[0m\x1b[${shift.top + 1};${shift.bottom + 1}r${scroll}\x1b[r`;
}

interface ScoredShift {
    readonly gain: number;
    readonly shift: ScrollShift;
}

/** Best upward shift: for every distance, each run of rows that equal the rows `lines` below them. */
function bestUpShift(previous: readonly string[], next: readonly string[]): ScoredShift | undefined {
    const height = next.length;
    let best: ScoredShift | undefined;
    for (let lines = 1; lines < height; lines++) {
        let row = 0;
        while (row < height - lines) {
            if (next[row] !== previous[row + lines]) {
                row++;
                continue;
            }
            const top = row;
            while (row < height - lines && next[row] === previous[row + lines]) row++;
            const candidate = scoreUpShift(previous, next, { top, bottom: row - 1 + lines, lines });
            if (!best || candidate.gain > best.gain) best = candidate;
        }
    }
    return best;
}

/** Rows the shift makes correct that were wrong, minus rows it breaks that were already right. */
function scoreUpShift(previous: readonly string[], next: readonly string[], shift: ScrollShift): ScoredShift {
    let gain = 0;
    for (let row = shift.top; row <= shift.bottom; row++) {
        const source = row + shift.lines;
        const after = source <= shift.bottom ? previous[source] : "";
        const wasRight = previous[row] === next[row];
        const isRight = after === next[row];
        if (isRight && !wasRight) gain++;
        else if (wasRight && !isRight) gain--;
    }
    return { gain, shift };
}
