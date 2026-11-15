import { CLEAR_LINE, SYNC_BEGIN, SYNC_END } from "../render/ansi";
import {
    deleteAllKittyImages,
    deleteAllKittyPlacements,
    getKittyImagePlacementRows,
    type ImageProtocol,
    isImageLine,
} from "../terminal-image";
import type { KittyImageCache } from "./kitty-cache";
import { HIDE_CURSOR, isWezTerm, SHOW_CURSOR } from "./terminal-modes";

const CLEAR_SCREEN = "\x1b[2J";

export interface ScreenUpdateInput {
    screen: string[];
    previousScreen: readonly string[];
    /** Size the previous screen was drawn at. */
    previousSize: { width: number; height: number };
    width: number;
    height: number;
    cursorPos: { row: number; col: number } | null;
    showHardwareCursor: boolean;
    imageProtocol: ImageProtocol;
    kittyCache: KittyImageCache;
}

/** Delete every kitty image this terminal has, if it speaks kitty. */
export function deleteAllImagesFor(protocol: ImageProtocol): string {
    return protocol === "kitty" ? deleteAllKittyImages() : "";
}

/**
 * The bytes that turn the previous screen into this one: rewrite only the
 * rows that changed, unless the size changed (redraw everything) or an image
 * is involved (images can't be patched row by row).
 */
export function buildScreenUpdate(input: ScreenUpdateInput): { output: string; fullRedraw: boolean } {
    const { screen, previousScreen, width, height, imageProtocol } = input;
    const fullRedraw =
        previousScreen.length === 0 || input.previousSize.width !== width || input.previousSize.height !== height;
    const changedRows = screen.map((line, row) => line !== previousScreen[row]);
    const imagesNeedRedraw = imagesNeedRedrawing(input, changedRows);
    const redrawImages = fullRedraw || imagesNeedRedraw;
    const hadUploadedKittyImages = input.kittyCache.size > 0;
    const prepared =
        redrawImages && imageProtocol === "kitty"
            ? input.kittyCache.prepare(screen)
            : { lines: screen, evictedImageDeletion: "" };

    let output = SYNC_BEGIN;
    if (fullRedraw) {
        const clearImages =
            imageProtocol === "kitty" && hadUploadedKittyImages
                ? deleteAllKittyPlacements()
                : deleteAllImagesFor(imageProtocol);
        output += `${clearImages}${CLEAR_SCREEN}`;
    } else if (imagesNeedRedraw) {
        if (imageProtocol === "iterm2") output += CLEAR_SCREEN;
        else if (imageProtocol === "kitty") output += deleteAllKittyPlacements();
    }
    output += prepared.evictedImageDeletion;

    const rowsToWrite = Array.from({ length: height }, (_, row) => row).filter(
        (row) => redrawImages || screen[row] !== previousScreen[row],
    );
    // WezTerm erases intersecting Kitty image cells when a later row write touches a covered row.
    // Draw image placements after every clear and text write so nothing later intersects them; preserve
    // the existing interleaved output for text-only frames and every other terminal.
    const drawKittyImagesLast = redrawImages && imageProtocol === "kitty" && screen.some(isImageLine) && isWezTerm();
    output += drawKittyImagesLast
        ? writeImagesLast(prepared.lines, rowsToWrite)
        : writeRows(prepared.lines, rowsToWrite);
    output += cursorPlacement(input.cursorPos, width, input.showHardwareCursor);
    return { output: output + SYNC_END, fullRedraw };
}

/** Changed rows touching an image need the image redrawn: always for its anchor row, and on WezTerm for any covered row. */
function imagesNeedRedrawing(input: ScreenUpdateInput, changedRows: boolean[]): boolean {
    const { screen, previousScreen } = input;
    const anchorsChanged = screen.some(
        (line, row) => changedRows[row] && (isImageLine(line) || isImageLine(previousScreen[row] ?? "")),
    );
    if (anchorsChanged) return true;
    // WezTerm drops a Kitty image's cells when any row it covers is rewritten, not just its anchor row.
    if (!isWezTerm() || input.imageProtocol !== "kitty" || !changedRows.some(Boolean)) return false;
    return screen.some((line, row) => {
        const placementRows = getKittyImagePlacementRows(line);
        if (placementRows === undefined) return false;
        for (let covered = row; covered < row + placementRows; covered++) {
            if (changedRows[covered]) return true;
        }
        return false;
    });
}

function moveTo(row: number): string {
    return `\x1b[${row + 1};1H`;
}

function writeRows(lines: string[], rows: number[]): string {
    return rows.map((row) => `${moveTo(row)}${CLEAR_LINE}${lines[row] ?? ""}`).join("");
}

/** Clear every row, write the text rows, then the image rows, so no text write lands on an image. */
function writeImagesLast(lines: string[], rows: number[]): string {
    const clears = rows.map((row) => `${moveTo(row)}${CLEAR_LINE}`).join("");
    const text = rows.filter((row) => !isImageLine(lines[row] ?? "")).map((row) => moveTo(row) + (lines[row] ?? ""));
    const images = rows.filter((row) => isImageLine(lines[row] ?? "")).map((row) => moveTo(row) + (lines[row] ?? ""));
    return clears + text.join("") + images.join("");
}

function cursorPlacement(cursorPos: { row: number; col: number } | null, width: number, show: boolean): string {
    if (!cursorPos) return HIDE_CURSOR;
    return `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H${show ? SHOW_CURSOR : HIDE_CURSOR}`;
}
