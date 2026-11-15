import { getCapabilities, setCellDimensions } from "../terminal-image";
import type { Terminal } from "../terminal";

/** Ask for the cell size in pixels (`CSI 16 t`); only images use it, so skip it otherwise. */
export function queryCellSize(terminal: Pick<Terminal, "write">): void {
    if (!getCapabilities().images) return;
    terminal.write("\x1b[16t");
}

/**
 * Consume a cell-size reply (`CSI 6 ; height ; width t`). Returns "none" if the
 * input is not one, "ignored" for a reply with no usable size, and "updated"
 * when the image cell dimensions changed.
 */
export function consumeCellSizeReport(data: string): "none" | "ignored" | "updated" {
    const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
    if (!match) return "none";
    const heightPx = parseInt(match[1], 10);
    const widthPx = parseInt(match[2], 10);
    if (heightPx <= 0 || widthPx <= 0) return "ignored";
    setCellDimensions({ widthPx, heightPx });
    return "updated";
}
