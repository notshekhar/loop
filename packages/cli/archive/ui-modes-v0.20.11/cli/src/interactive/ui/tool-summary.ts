/**
 * Single source of truth for how a tool call is summarized on one line — used
 * by the live tool box (tool-execution.ts) and the /tree row (entry-display.ts)
 * so both describe a call identically. Pure + uncolored; callers apply theme.
 *
 * Tools loop doesn't ship are summarized by their own extension, via the
 * renderer seam below — nothing here knows about any extension's arguments.
 */
import { getExtensionHost, type ExtensionTheme } from "@notshekhar/loop-core";
import { theme, type Theme } from "./theme";
import { highlightShellCommand } from "./shell-highlight";
import { activeUiMode } from "./ui-mode";

type ThemeSlot = Parameters<Theme["fg"]>[0];

/**
 * The active theme, adapted to the extension-facing shape. Unknown slots come
 * back unstyled instead of throwing (the real `Theme` throws), because an
 * extension naming a slot loop doesn't have must not break a repaint.
 */
const extensionTheme: ExtensionTheme = {
    get name() {
        return theme.name;
    },
    fg: (slot, text) => {
        try {
            return theme.fg(slot as never, text);
        } catch {
            return text;
        }
    },
    bg: (slot, text) => {
        try {
            return theme.bg(slot as never, text);
        } catch {
            return text;
        }
    },
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
};

/** Shorten an absolute path under `cwd` to a repo-relative one (or `.` for cwd). */
function rel(p: unknown, cwd: string): string {
    if (typeof p !== "string") return "";
    return p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\//, "") || "." : p;
}

/**
 * A guard, not a layout decision.
 *
 * These summaries used to be cut to 80 characters right here, which stopped
 * being a terminal's width a long time ago: on a 200-column window a bash row
 * was clipped at 80 with a hundred columns of nothing beside it, and no setting
 * could widen it because the cut had already happened by the time anyone knew
 * how much room there was. Every renderer already fits a row to the real
 * width — `fitRow` in noir, the group table's `avail` clamp, the box in the
 * default mode — so the only job left here is keeping a pathological argument
 * (a minified one-liner, a megabyte of JSON) out of per-frame layout work.
 * Well past any real terminal, so it never decides what you see.
 */
const SUMMARY_MAX = 1000;

/** Suffix a backgrounded bash call carries — split off before highlighting. */
export const BACKGROUND_SUFFIX = " (background)";

function clamp(text: string): string {
    return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

/**
 * One-line argument summary for a tool call. Empty string when there's nothing
 * useful to show (e.g. a pending call whose input hasn't streamed yet).
 *
 * Uncoloured and width-agnostic: the caller knows how wide the row is and cuts
 * it there. See {@link highlightShellCommand} for the colouring bash gets.
 */
export function formatToolArgs(toolName: string, args: Record<string, unknown>, cwd: string): string {
    if (Object.keys(args).length === 0) return "";
    // An extension that contributes a tool owns how it reads: ask first, so
    // loop needs no knowledge of any tool it doesn't ship itself.
    const custom = getExtensionHost().renderToolSummary(toolName, args, {
        cwd,
        uiMode: activeUiMode().id,
        theme: extensionTheme,
    });
    if (custom !== undefined) return custom;
    const a = args;
    switch (toolName) {
        case "read":
        case "write":
        case "edit":
        case "ls":
            return rel(a.path ?? a.file_path ?? a.filePath, cwd);
        case "bash": {
            const cmd = typeof a.command === "string" ? a.command : "";
            // A backgrounded command is labelled where it starts: the row is
            // the only place the transcript ever says the run did not finish
            // here, and its output lives in the shells panel instead.
            const bg = a.run_in_background === true ? BACKGROUND_SUFFIX : "";
            return clamp(cmd.split("\n")[0]) + bg;
        }
        case "shells": {
            const action = typeof a.action === "string" ? a.action : "";
            const id = typeof a.id === "string" ? a.id : "";
            if (action === "list") return "list";
            return [action, id].filter(Boolean).join(" ");
        }
        case "grep":
            return [a.pattern, rel(a.path, cwd)].filter(Boolean).join(" in ");
        case "find":
            return typeof a.pattern === "string" ? a.pattern : "";
        case "websearch":
            return typeof a.query === "string" ? a.query : "";
        case "skill":
            return typeof a.name === "string" ? a.name : "";
        case "sql": {
            const conn = typeof a.connectionId === "string" ? a.connectionId : "";
            const q = typeof a.query === "string" ? a.query.replace(/\s+/g, " ").trim() : "";
            return [conn, clamp(q)].filter(Boolean).join(" · ");
        }
        case "plan":
        case "exit_plan_mode": {
            // The plan body renders as markdown below the title — the summary
            // is its first heading, never the raw JSON blob.
            const plan = typeof a.plan === "string" ? a.plan : "";
            return clamp((plan.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim());
        }
        default:
            return clamp(JSON.stringify(a));
    }
}

/**
 * A tool summary with colouring of its own, or null when the caller should
 * apply the muted slot it always has.
 *
 * Only `bash`. Its summary is not a description of a call, it IS one — a shell
 * command, the same text a terminal would have coloured had you typed it — and
 * every other summary here is a path or a pattern that reads fine flat. Kept
 * out of `formatToolArgs` so that stays pure and uncoloured for the callers
 * that measure it.
 */
export function highlightToolSummary(toolName: string, summary: string, base: ThemeSlot = "muted"): string | null {
    if (toolName !== "bash" || !summary) return null;
    // An extension may own bash's summary and return text that is already
    // coloured; a second pass would nest escapes and could cut one in half.
    if (summary.includes("\x1b")) return null;
    const background = summary.endsWith(BACKGROUND_SUFFIX);
    const command = background ? summary.slice(0, -BACKGROUND_SUFFIX.length) : summary;
    if (!command) return null;
    const painted = highlightShellCommand(command, base);
    return background ? painted + theme.fg("dim", BACKGROUND_SUFFIX) : painted;
}

/**
 * A subagent call's prompt, as the one line a task row shows.
 *
 * This was cut to 50 characters in the noir row, 50 again in the default box,
 * and 60 in the tree — three copies of one idea disagreeing about the number,
 * none of them knowing how wide the terminal was. It is the first line now, and
 * the row that draws it decides where it ends.
 */
export function taskPromptSnippet(args: Record<string, unknown>): string {
    return typeof args.prompt === "string" ? clamp(args.prompt.split("\n")[0]) : "";
}

/** `read`'s `:start` / `:start-end` line range from offset/limit, or "". */
export function readLineRangeText(args: Record<string, unknown>): string {
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    if (offset === undefined && limit === undefined) return "";
    const start = offset ?? 1;
    const end = limit !== undefined ? start + limit - 1 : "";
    return `:${start}${end ? `-${end}` : ""}`;
}

/** A `[…]`-only result line — the read tool's notices, never file content. */
const READ_NOTICE_RE = /^\[.*\]$/;

/**
 * Right-aligned absolute line numbers for a `read` result, one prefix per
 * output line (empty string = don't number this line).
 *
 * The numbering starts at the call's `offset`, not at 1: an offset read shows
 * the file's real line numbers, which is the whole point — a preview that
 * restarts at 1 can't be matched back to the file it came from.
 *
 * The tool appends its own `[Showing lines … ]` / `[N more lines … ]` notice
 * after a blank line, and a whole-result notice (image file, over-limit line)
 * is a message rather than a body — neither gets a number.
 */
export function readGutterPrefixes(lines: string[], args: Record<string, unknown>): string[] {
    if (lines.length === 0) return [];
    if (lines.length === 1 && READ_NOTICE_RE.test(lines[0].trim())) return [""];
    const base = typeof args.offset === "number" ? args.offset : 1;
    let bodyEnd = lines.length;
    if (bodyEnd >= 2 && READ_NOTICE_RE.test(lines[bodyEnd - 1].trim()) && lines[bodyEnd - 2].trim() === "") {
        bodyEnd -= 2;
    }
    const width = String(base + Math.max(0, bodyEnd - 1)).length;
    return lines.map((_, i) => (i < bodyEnd ? `${String(base + i).padStart(width)}  ` : ""));
}

/**
 * Full one-line invocation label for a resolved tool call: `toolName summary`.
 * `task` shows its agent + prompt snippet; `read` appends its line range. Used
 * for /tree rows and search text, where no live status is available.
 */
export function formatToolInvocation(toolName: string, args: Record<string, unknown>, cwd: string): string {
    if (toolName === "task") {
        const agent = typeof args.agent === "string" ? args.agent : "default";
        const prompt = taskPromptSnippet(args);
        return prompt ? `task ${agent}: ${prompt}` : `task ${agent}`;
    }
    const summary = formatToolArgs(toolName, args, cwd);
    const range = toolName === "read" ? readLineRangeText(args) : "";
    return summary ? `${toolName} ${summary}${range}` : toolName;
}
