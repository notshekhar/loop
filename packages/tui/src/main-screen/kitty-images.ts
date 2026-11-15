import { deleteKittyImage, isImageLine } from "../terminal-image";
import { visibleWidth } from "../utils";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

interface KittyImageHeader {
    ids: number[];
    rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
    const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
    if (sequenceStart === -1) return undefined;
    const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
    const paramsEnd = line.indexOf(";", paramsStart);
    if (paramsEnd === -1) return undefined;

    const ids: number[] = [];
    let rows = 1;
    for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
        const [key, value] = param.split("=", 2);
        if (value === undefined) continue;
        const numberValue = Number(value);
        if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
        if (key === "i") ids.push(numberValue);
        else if (key === "r") rows = numberValue;
    }
    return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
    return parseKittyImageHeader(line)?.ids ?? [];
}

export function collectKittyImageIds(lines: string[]): Set<number> {
    const ids = new Set<number>();
    for (const line of lines) {
        for (const id of extractKittyImageIds(line)) ids.add(id);
    }
    return ids;
}

/** Escape sequences deleting the given images. */
export function deleteKittyImages(ids: Iterable<number>): string {
    let buffer = "";
    for (const id of ids) buffer += deleteKittyImage(id);
    return buffer;
}

/**
 * How many rows the image starting at `index` really occupies: what its
 * header asks for, cut short at the first row that already holds something.
 */
export function kittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
    const rows = parseKittyImageHeader(lines[index] ?? "")?.rows ?? 1;
    if (rows <= 1) return 1;
    const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
    let reservedRows = 1;
    while (reservedRows < maxRows) {
        const line = lines[index + reservedRows] ?? "";
        if (isImageLine(line) || visibleWidth(line) > 0) break;
        reservedRows++;
    }
    return reservedRows;
}

/** Widen a changed range so any image overlapping it is redrawn whole. */
export function expandChangedRangeForKittyImages(
    previousLines: string[],
    newLines: string[],
    firstChanged: number,
    lastChanged: number,
): { firstChanged: number; lastChanged: number } {
    let first = firstChanged;
    let last = lastChanged;
    for (const lines of [previousLines, newLines]) {
        for (let i = 0; i < lines.length; i++) {
            if (extractKittyImageIds(lines[i]).length === 0) continue;
            const blockEnd = i + kittyImageReservedRows(lines, i) - 1;
            if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
                first = Math.min(first, i);
                last = Math.max(last, blockEnd);
            }
        }
    }
    return { firstChanged: first, lastChanged: last };
}

/** Delete every image the previous frame drew in rows [firstChanged, lastChanged]. */
export function deleteChangedKittyImages(previousLines: string[], firstChanged: number, lastChanged: number): string {
    if (firstChanged < 0 || lastChanged < firstChanged) return "";
    const ids = new Set<number>();
    const maxLine = Math.min(lastChanged, previousLines.length - 1);
    for (let i = firstChanged; i <= maxLine; i++) {
        for (const id of extractKittyImageIds(previousLines[i] ?? "")) ids.add(id);
    }
    return deleteKittyImages(ids);
}
