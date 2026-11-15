import * as fs from "node:fs";
import * as path from "node:path";
import { visibleWidth } from "../utils";

/** With PI_DEBUG_REDRAW=1, record why a full redraw happened. */
export function logRedraw(
    logDirectory: string,
    reason: string,
    counts: { previous: number; next: number; height: number },
): void {
    if (process.env.PI_DEBUG_REDRAW !== "1") return;
    const logPath = path.join(logDirectory, "render-debug.log");
    const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${counts.previous}, new=${counts.next}, height=${counts.height})\n`;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, msg);
}

/**
 * A line wider than the terminal would wrap and wreck every row below it.
 * Write all the frame's lines to a crash log and return the error to throw.
 */
export function overwideLineError(logDirectory: string, lines: string[], index: number, width: number): Error {
    const line = lines[index]!;
    const crashLogPath = path.join(logDirectory, "render-crash.log");
    const crashData = [
        `Crash at ${new Date().toISOString()}`,
        `Terminal width: ${width}`,
        `Line ${index} visible width: ${visibleWidth(line)}`,
        "",
        "=== All rendered lines ===",
        ...lines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
        "",
    ].join("\n");
    fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
    fs.writeFileSync(crashLogPath, crashData);
    return new Error(
        [
            `Rendered line ${index} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
            "",
            "This is likely caused by a custom TUI component not truncating its output.",
            "Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
            "",
            `Debug log written to: ${crashLogPath}`,
        ].join("\n"),
    );
}

/** With PI_TUI_DEBUG=1, dump one incremental render's bookkeeping to /tmp/tui. */
export function dumpIncrementalRender(
    fields: Record<string, unknown>,
    newLines: string[],
    previousLines: string[],
    writtenChars: number,
): void {
    if (process.env.PI_TUI_DEBUG !== "1") return;
    const debugDir = "/tmp/tui";
    fs.mkdirSync(debugDir, { recursive: true });
    const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const debugData = [
        ...Object.entries(fields).map(
            ([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`,
        ),
        `newLines.length: ${newLines.length}`,
        `previousLines.length: ${previousLines.length}`,
        "",
        "=== newLines ===",
        JSON.stringify(newLines, null, 2),
        "",
        "=== previousLines ===",
        JSON.stringify(previousLines, null, 2),
        "",
        "=== buffer ===",
        `[${writtenChars} chars written in bounded chunks]`,
    ].join("\n");
    fs.writeFileSync(debugPath, debugData);
}
