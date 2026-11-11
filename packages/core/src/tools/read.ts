import { PRODUCT_NAME } from "../brand";
import { access as fsAccess, stat as fsStat } from "node:fs/promises";
import { constants } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { resolveReadPath } from "./utils/path-utils";
import { enforcePathPermission } from "./utils/permission-rules";
import { recordRead } from "./utils/read-registry";
import { fetchUrlAsText, isHttpUrl } from "./utils/fetch-url";
import { getDoc, renderDocsIndex } from "../docs";
import { looksBinary, selectLines } from "./utils/read-file-lines";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./utils/truncate";

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;

/** Single-quote a path for the bash hints in truncation messages. */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function detectImageMimeType(path: string): string | null {
    const m = path.match(IMAGE_EXT_RE);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    return null;
}

export interface ReadToolContext {
    cwd: string;
    abortSignal?: AbortSignal;
    /** Scopes the read-before-edit registry (see tools/index.ts ToolContext). */
    sessionId?: string;
}

/** Resolve a `loop://` URI: docs index, a specific doc, or a wrapped URL fetch. */
async function readLoopUri(uri: string, signal?: AbortSignal): Promise<string> {
    const rest = uri.slice(`${PRODUCT_NAME}://`.length);
    if (rest === "docs" || rest === "docs/") {
        return renderDocsIndex();
    }
    if (rest.startsWith("docs/")) {
        const name = rest.slice("docs/".length);
        const doc = getDoc(name);
        if (!doc) return `[no such doc: ${name}]\n\n${renderDocsIndex()}`;
        return doc.content;
    }
    if (rest.startsWith("fetch/")) {
        const url = rest.slice("fetch/".length).trim();
        if (!isHttpUrl(url)) return `[${PRODUCT_NAME}://fetch/ expects an http(s):// URL, got: ${url}]`;
        return fetchUrlAsText(url, signal);
    }
    return `[unknown ${PRODUCT_NAME}:// path: ${uri}. Use ${PRODUCT_NAME}://docs, ${PRODUCT_NAME}://docs/<name>.md, or ${PRODUCT_NAME}://fetch/<url>]`;
}

export function createReadTool(ctx: ReadToolContext) {
    return tool({
        description: `Read the contents of a file, fetch a URL, or read ${PRODUCT_NAME}'s internal docs.

- Local path → reads the file (text, truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; use offset/limit for large files; continue with offset until complete).
- \`${PRODUCT_NAME}://fetch/<url>\` (or a bare http(s):// URL) → fetches the page and returns it as readable text (HTML stripped).
- \`${PRODUCT_NAME}://docs\` → lists ${PRODUCT_NAME}'s internal docs. \`${PRODUCT_NAME}://docs/<name>.md\` reads one (e.g. \`${PRODUCT_NAME}://docs/config.md\`).

IMPORTANT: when the user asks to add or change a model, custom provider, datasource (database connection for the \`sql\` tool), hook, MCP server, permission rule, or custom agent, FIRST read \`${PRODUCT_NAME}://docs/config.md\` for the exact file locations and JSON shapes, then make the change yourself with edit/write. ${PRODUCT_NAME}'s config is plain JSON and markdown files that you can edit — do NOT tell the user to go configure it by hand in a slash-command panel, and do not claim you are unable to. After editing any ${PRODUCT_NAME} config, tell the user to hard-reload with /reload or by restarting ${PRODUCT_NAME} — config changes don't apply to the running session until then.`,
        inputSchema: z.object({
            path: z
                .string()
                .describe(
                    `Local file path (relative or absolute), an http(s):// URL, or a ${PRODUCT_NAME}:// URI (${PRODUCT_NAME}://docs, ${PRODUCT_NAME}://docs/<name>.md, ${PRODUCT_NAME}://fetch/<url>)`,
                ),
            offset: z.number().int().positive().optional().describe("Line number to start reading from (1-indexed)"),
            limit: z.number().int().positive().optional().describe("Maximum number of lines to read"),
        }),
        execute: async ({ path, offset, limit }, options) => {
            const signal = options?.abortSignal ?? ctx.abortSignal;
            if (signal?.aborted) throw new Error("Operation aborted");
            const trimmed = path.trim();
            // loop:// scheme → internal docs or wrapped URL fetch.
            if (trimmed.toLowerCase().startsWith(`${PRODUCT_NAME}://`)) {
                return readLoopUri(trimmed, signal);
            }
            // URL → fetch as text (offset/limit don't apply to web content).
            if (isHttpUrl(path)) {
                return fetchUrlAsText(trimmed, signal);
            }
            const absolutePath = resolveReadPath(path, ctx.cwd);
            // Permission rules: Read(...) deny/ask patterns gate file reads.
            await enforcePathPermission({
                classes: ["read"],
                paths: [trimmed, absolutePath],
                cwd: ctx.cwd,
                what: `Reading \`${path}\``,
                signal,
            });
            await fsAccess(absolutePath, constants.R_OK);
            // Stat before reading: the mtime recorded for read-before-modify has
            // to predate the content, and directories need their own message.
            const stat = await fsStat(absolutePath);
            if (stat.isDirectory()) {
                throw new Error(
                    `${path} is a directory, not a file. Use ls to list its contents, or find to match files inside it.`,
                );
            }
            const mime = detectImageMimeType(absolutePath);
            if (mime) {
                return `[image file: ${mime} at ${absolutePath}. Image rendering not supported in this tool result; use bash 'file' or vision-capable read elsewhere.]`;
            }
            if (await looksBinary(absolutePath)) {
                return `[binary file: ${formatSize(stat.size)} at ${absolutePath}. Not printed as text; inspect it with bash (file, xxd, strings).]`;
            }
            const selection = await selectLines(absolutePath, { offset, limit, size: stat.size, signal });
            const startLineDisplay = selection.startLine;
            // Unlocks edit for this file; write needs coverage of the whole file,
            // which successive offset= reads accumulate (read-before-modify).
            recordRead(absolutePath, ctx.sessionId, {
                mtimeMs: stat.mtimeMs,
                range: selection.lines.length
                    ? [startLineDisplay, startLineDisplay + selection.lines.length - 1]
                    : undefined,
                sawEof: !selection.hasMore,
            });

            if (selection.firstLineBytes !== undefined) {
                const size = formatSize(selection.firstLineBytes);
                const measured = selection.firstLineClipped ? `over ${size}` : `${size}`;
                return `[Line ${startLineDisplay} is ${measured}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${shellQuote(path)} | head -c ${DEFAULT_MAX_BYTES}]`;
            }
            let outputText = selection.lines.join("\n");
            if (selection.trailingNewline) outputText += "\n";
            if (!selection.hasMore) return outputText;

            const endLineDisplay = startLineDisplay + selection.lines.length - 1;
            const nextOffset = endLineDisplay + 1;
            // `of N` only when the file was scanned end to end — a streamed read
            // of a huge file stops early and never learns the total.
            const ofTotal = selection.totalLines === undefined ? "" : ` of ${selection.totalLines}`;
            if (selection.truncatedBy === "lines") {
                outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay}${ofTotal}. Use offset=${nextOffset} to continue.]`;
            } else if (selection.truncatedBy === "bytes") {
                outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay}${ofTotal} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
            } else if (selection.totalLines !== undefined) {
                const remaining = selection.totalLines - endLineDisplay;
                outputText += `\n\n[${remaining} more line${remaining === 1 ? "" : "s"} in file. Use offset=${nextOffset} to continue.]`;
            } else {
                outputText += `\n\n[More lines in file. Use offset=${nextOffset} to continue.]`;
            }
            return outputText;
        },
    });
}
