import { visibleWidth } from "../../utils";

/** A word longer than this may be broken, so one long URL can't starve every other column. */
export const MAX_UNBROKEN_WORD_WIDTH = 30;

/** Width of the longest word in `text`, capped at `maxWidth`. */
export function longestWordWidth(text: string, maxWidth?: number): number {
    let longest = 0;
    for (const word of text.split(/\s+/)) {
        if (word.length > 0) longest = Math.max(longest, visibleWidth(word));
    }
    return maxWidth === undefined ? longest : Math.min(longest, maxWidth);
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/**
 * Column minimums: each column's longest word — or, when those don't all
 * fit, one cell each plus the remaining space shared by how much each column
 * wanted beyond one cell.
 */
function minimumWidths(minWordWidths: number[], availableForCells: number): number[] {
    if (sum(minWordWidths) <= availableForCells) return minWordWidths;
    const numCols = minWordWidths.length;
    const minimums = new Array<number>(numCols).fill(1);
    const remaining = availableForCells - numCols;
    if (remaining <= 0) return minimums;
    const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
    const growth = minWordWidths.map((width) =>
        totalWeight > 0 ? Math.floor((Math.max(0, width - 1) / totalWeight) * remaining) : 0,
    );
    for (let i = 0; i < numCols; i++) minimums[i] += growth[i] ?? 0;
    let leftover = remaining - sum(growth);
    for (let i = 0; leftover > 0 && i < numCols; i++) {
        minimums[i]++;
        leftover--;
    }
    return minimums;
}

/**
 * Fit columns into `availableWidth`: natural widths when everything fits,
 * otherwise minimums plus the spare space shared by how much each column
 * wanted, with rounding leftovers handed out one cell at a time.
 */
export function fitColumnWidths(
    naturalWidths: number[],
    minWordWidths: number[],
    availableWidth: number,
    borderOverhead: number,
): number[] {
    const availableForCells = availableWidth - borderOverhead;
    const minimums = minimumWidths(minWordWidths, availableForCells);
    if (sum(naturalWidths) + borderOverhead <= availableWidth) {
        return naturalWidths.map((width, index) => Math.max(width, minimums[index]));
    }
    const totalGrowPotential = naturalWidths.reduce(
        (total, width, index) => total + Math.max(0, width - minimums[index]),
        0,
    );
    const extraWidth = Math.max(0, availableForCells - sum(minimums));
    const widths = minimums.map((minWidth, index) => {
        const wants = Math.max(0, naturalWidths[index] - minWidth);
        return minWidth + (totalGrowPotential > 0 ? Math.floor((wants / totalGrowPotential) * extraWidth) : 0);
    });
    distributeRemainder(widths, naturalWidths, availableForCells - sum(widths));
    return widths;
}

/** Give rounding leftovers to columns still short of their natural width. */
function distributeRemainder(widths: number[], naturalWidths: number[], remaining: number): void {
    let left = remaining;
    while (left > 0) {
        let grew = false;
        for (let i = 0; i < widths.length && left > 0; i++) {
            if (widths[i] < naturalWidths[i]) {
                widths[i]++;
                left--;
                grew = true;
            }
        }
        if (!grew) break;
    }
}
