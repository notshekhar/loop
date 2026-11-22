/**
 * What a finished tool call actually RETURNED, in one line.
 *
 * A row like `◆ read src/app.ts` says what was asked for and nothing about
 * what came back — which is fine in a mode that shows the output underneath,
 * and is the whole problem in one that folds it away. The receipt is the
 * missing half: `580 lines`, `exit 1 · 214 lines`, `+12 −4 · 2 blocks`. Enough
 * that a scrolled-back transcript reads as a record of what happened rather
 * than a list of what was attempted.
 *
 * Pure and uncoloured, like {@link formatToolArgs} beside it — callers apply
 * the theme, and the same text serves any surface that wants it (a noir row, a
 * folded group's member line, a /tree entry).
 *
 * Every rule here reads a tool's REAL result text, whose shapes are set in
 * packages/core/src/tools. Two conventions recur and are worth naming once:
 *
 * - a trailing bracketed notice (`[Showing lines 1-500 of 2000. …]`) after a
 *   blank line, which read/grep/ls/bash all append and none of which is body;
 * - a `summary` line followed by a diff, for edit/write, split on a blank line
 *   (`DIFF_SEPARATOR`) so the model can be shown only the head.
 *
 * When a rule can't read what it expected it returns "" rather than guess. A
 * missing receipt costs a glance at the expanded output; a wrong one is a lie
 * the transcript now tells every time it is scrolled past.
 *
 * The second half of the file is the PEEK: the few lines of real output a
 * folded row shows under its receipt. A receipt says how much came back; the
 * peek says what it was.
 */
import { kindIdOf } from "./verb-group";

/** Longest receipt we'll produce — it shares a row with the call's summary. */
const MAX_RECEIPT = 44;

/** A `[…]`-only line: a tool's own notice, never part of its body. */
const NOTICE_RE = /^\[.*\]$/;

/** The three status lines bash appends after its output (see bash.ts). */
const BASH_STATUS_RE = /^(Command exited with code (\d+)|Command aborted|Command timed out after (\d+) seconds)$/;

/** `a`, or `a` with an ellipsis, so a receipt never widens past its budget. */
function clip(text: string, max = MAX_RECEIPT): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * Split a result into its body and the trailing pieces that aren't body: the
 * bracketed notice tools append, and bash's status line after it.
 *
 * Both ride after a blank line, so they're identifiable without knowing which
 * tool produced them — and both would otherwise be counted as content, which
 * is exactly the kind of off-by-a-few that makes a receipt untrustworthy.
 */
function split(output: string): { body: string[]; notice: string; status: string } {
    const lines = output.replace(/\s+$/, "").split("\n");
    let status = "";
    let notice = "";
    /** Pop a trailing `[blank, line]` pair when `line` matches. */
    const takeTrailer = (re: RegExp): string => {
        const last = lines[lines.length - 1];
        if (last === undefined || !re.test(last.trim())) return "";
        // The separator is always one blank line; without it this is body that
        // merely happens to look like a trailer.
        if (lines.length >= 2 && lines[lines.length - 2].trim() !== "") return "";
        const taken = last.trim();
        lines.pop();
        if (lines.length > 0) lines.pop();
        return taken;
    };
    status = takeTrailer(BASH_STATUS_RE);
    notice = takeTrailer(NOTICE_RE);
    // A result that is nothing BUT a notice (an image read, a websearch error)
    // has no body at all — say so rather than reporting "1 line".
    if (lines.length === 1 && NOTICE_RE.test(lines[0].trim())) {
        return { body: [], notice: lines[0].trim(), status };
    }
    return { body: lines, notice, status };
}

/** Body line count, ignoring a trailing blank the tool's own newline left. */
function bodyLines(body: string[]): number {
    let n = body.length;
    while (n > 0 && body[n - 1].trim() === "") n--;
    return n;
}

/** `+12 −4` from a diff, counting only real +/- rows (see generateDiffString:
 * every emitted line starts `+`, `-` or a space, then a padded line number). */
function diffStat(lines: string[]): { added: number; removed: number } | null {
    let added = 0;
    let removed = 0;
    let sawDiff = false;
    for (const l of lines) {
        if (l.startsWith("+")) {
            added++;
            sawDiff = true;
        } else if (l.startsWith("-")) {
            removed++;
            sawDiff = true;
        } else if (l.startsWith(" ")) {
            sawDiff = true;
        }
    }
    return sawDiff && (added > 0 || removed > 0) ? { added, removed } : null;
}

/** `+12 −4`, with a real minus sign — the ASCII hyphen reads as a dash here. */
function fmtDiff(stat: { added: number; removed: number }): string {
    const parts: string[] = [];
    if (stat.added > 0) parts.push(`+${stat.added}`);
    if (stat.removed > 0) parts.push(`−${stat.removed}`);
    return parts.join(" ");
}

/**
 * The head of a `[…]` notice that IS the whole result — an image, a binary, a
 * line too long to print.
 *
 * Each is written as a fact then advice ("[binary file: 4.2 KB at /abs/path.
 * Not printed as text; inspect it with bash…]"), and only the fact is a
 * receipt. Cut at the absolute path where there is one, else at the first
 * sentence break — NOT at any period, which would end "4.2 KB" at "4".
 */
function noticeHead(notice: string): string {
    const inner = notice.replace(/^\[|\]$/g, "");
    const atPath = inner.search(/ at \//);
    if (atPath !== -1) return clip(inner.slice(0, atPath));
    const sentence = inner.search(/\.\s/);
    return clip(sentence === -1 ? inner : inner.slice(0, sentence));
}

/** The `read` receipt: a line count, or the real range when the file was cut. */
function readReceipt(body: string[], notice: string, args: Record<string, unknown>): string {
    // A whole-result notice IS the answer (image, binary, over-long line) —
    // report it as itself rather than as "0 lines".
    if (body.length === 0 && notice) return noticeHead(notice);
    const n = bodyLines(body);
    const shown = /^\[Showing lines (\d+)-(\d+)(?: of (\d+))?/.exec(notice);
    if (shown) {
        const total = shown[3];
        return total ? `lines ${shown[1]}–${shown[2]} of ${total}` : `lines ${shown[1]}–${shown[2]}`;
    }
    const more = /^\[(\d+) more lines? in file/.exec(notice);
    if (more) return `${n} of ${n + Number(more[1])} lines`;
    // An offset read that reached EOF carries no notice, so the range has to
    // come from the arguments — but only when it is NEWS. The row's title
    // already shows the range that was asked for (`read app.ts:120-180`), so
    // repeating it here says nothing; what the title cannot know is that the
    // file ended early, and that is the one case worth a range.
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    if (offset !== undefined && n > 0) {
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const asked = limit === undefined ? undefined : offset + limit - 1;
        if (asked !== undefined && offset + n - 1 < asked) return `lines ${offset}–${offset + n - 1}`;
    }
    return plural(n, "line");
}

/** The `bash` receipt: how it ended, then how much it said. */
function bashReceipt(body: string[], status: string, output: string, isError: boolean): string {
    // Backgrounded (explicitly, or promoted on timeout) — the row is the only
    // place the transcript says the run did not finish here.
    const bg = /^(?:Started|.*moved to the background as) (\S+?)[\s.(]/m.exec(output);
    if (bg && /background/.test(output)) return `background ${bg[1]}`;

    const n = bodyLines(body);
    const amount = n === 0 ? "no output" : plural(n, "line");
    const exit = /^Command exited with code (\d+)$/.exec(status);
    if (exit) return `exit ${exit[1]} · ${amount}`;
    if (status === "Command aborted") return `aborted · ${amount}`;
    const timeout = /^Command timed out after (\d+) seconds$/.exec(status);
    if (timeout) return `timed out ${timeout[1]}s · ${amount}`;
    // A failure that carries none of those trailers never reached the exit
    // code — the command could not be spawned, or the sandbox refused it. Say
    // that it failed rather than reporting the "ok" no evidence supports.
    if (isError) return `failed · ${amount}`;
    return n === 0 ? "ok · no output" : `ok · ${amount}`;
}

/** The `grep` receipt: matches, and how many files they came from. */
function grepReceipt(body: string[]): string {
    const files = new Set<string>();
    let matches = 0;
    for (const l of body) {
        const m = /^(.*?):(\d+): /.exec(l);
        if (!m) continue;
        matches++;
        files.add(m[1]);
    }
    // Context mode interleaves separators and unnumbered rows; if nothing
    // parsed, fall back to a count we can actually stand behind.
    if (matches === 0) return plural(bodyLines(body), "line");
    return `${plural(matches, "match", "matches")} · ${plural(files.size, "file")}`;
}

/**
 * One line describing what `toolName` returned, or "" when there is nothing
 * honest to say. `output` is the flattened result text exactly as the row
 * would render it.
 */
export function formatToolReceipt(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    isError: boolean,
): string {
    // A result that is genuinely empty. Two tools mean something by it and say
    // so — a command that printed nothing still ran, and an empty file was
    // still read — while for everyone else silence is the honest receipt.
    if (!output.trim()) {
        if (toolName === "bash") return isError ? "failed · no output" : "ok · no output";
        if (toolName === "read") return "empty file";
        return "";
    }
    const { body, notice, status } = split(output);

    // bash reports its own failures (the exit code is the news, not the first
    // line of a stack trace), so it is handled before the generic error rule.
    if (toolName === "bash") return bashReceipt(body, status, output, isError);

    if (isError) {
        // A one-line failure needs no expansion — say it here and be done.
        const first = body.find((l) => l.trim()) ?? notice.replace(/^\[|\]$/g, "");
        const n = bodyLines(body);
        return n <= 1 ? clip(first) : `failed · ${plural(n, "line")}`;
    }

    switch (toolName) {
        case "read":
            return readReceipt(body, notice, args);

        case "edit": {
            const stat = diffStat(body);
            const blocks = Array.isArray(args.edits) ? args.edits.length : 0;
            if (!stat) return blocks ? plural(blocks, "block") : "";
            return blocks > 1 ? `${fmtDiff(stat)} · ${plural(blocks, "block")}` : fmtDiff(stat);
        }

        case "write": {
            const stat = diffStat(body);
            if (stat) return fmtDiff(stat);
            if (/\(content unchanged\)/.test(output)) return "unchanged";
            // A new file has nothing to diff against, so its size comes from
            // the argument we sent rather than from a result that never had it.
            const content = typeof args.content === "string" ? args.content : "";
            return content ? `new · ${plural(content.replace(/\n$/, "").split("\n").length, "line")}` : "new";
        }

        case "grep":
            return /^No matches found$/m.test(output) ? "no matches" : grepReceipt(body);

        case "find":
        case "glob":
            return /^No files found matching pattern$/m.test(output) ? "no matches" : plural(bodyLines(body), "file");

        case "ls":
        case "tree":
            return /^\(empty directory\)$/m.test(output) ? "empty" : plural(bodyLines(body), "entry", "entries");

        case "sql": {
            const rows = /^\((\d+) rows?\)$|^(\d+) row\(s\):/m.exec(output);
            const n = rows ? Number(rows[1] ?? rows[2]) : undefined;
            return n === undefined ? plural(bodyLines(body), "line") : plural(n, "row");
        }

        case "ask": {
            // formatAskAnswers (core/tools/ask.ts) writes "User answers:", then
            // one `[Header] question` / `→ answer` block per question, or a
            // single decline sentence for the whole call.
            if (/^The user declined to answer/m.test(output)) return "declined";
            const answers = body.filter((l) => l.startsWith("→ ") && !l.startsWith("→ user note:"));
            if (answers.length === 0) return "answered";
            // One question: the answer IS the receipt — it is short, and it is
            // the thing you scroll back to a question to re-read. Several: say
            // how many and let the row be opened, since three answers on one
            // line is not something anyone reads.
            if (answers.length > 1) return `answered · ${plural(answers.length, "question")}`;
            const only = answers[0].replace(/^→\s*/, "").replace(/^\(custom answer\)\s*/, "");
            return `answered · ${clip(only.replace(/^"|"$/g, ""), MAX_RECEIPT - 11)}`;
        }

        case "code": {
            // core tools/code-mode/result.ts opens every result with this line.
            const calls = /^Script completed \((\d+) tool calls?\)\./.exec(output);
            return calls ? plural(Number(calls[1]), "call") : plural(bodyLines(body), "line");
        }

        case "websearch": {
            const results = body.filter((l) => /^\d+\. /.test(l)).length;
            return results > 0 ? plural(results, "result") : plural(bodyLines(body), "line");
        }

        default:
            // Somebody else's tool, or one of ours whose result has no shape
            // worth naming. A line count is the most we actually know.
            return plural(bodyLines(body), "line");
    }
}

// ---------------------------------------------------------------------------
// The peek — a few lines of the real output, under a folded row's receipt
// ---------------------------------------------------------------------------

/**
 * Which END of a result is worth showing when only a few lines fit.
 *
 * - `tail` — a command's verdict is at the BOTTOM. The last lines of a test
 *   run say what failed; its first lines say it started.
 * - `head` — a search, a listing, a query answers at the TOP, and its ordering
 *   is the answer's ranking.
 * - `hunk` — a diff's summary line is chrome; the first CHANGED lines are the
 *   news, so context rows are skipped to spend the budget on `+`/`-`.
 * - `none` — nothing worth showing. `read` is the whole of this case: you
 *   named the file, and the receipt already says how much of it came back.
 */
type PeekEnd = "head" | "tail" | "hunk" | "none";

/**
 * The peek policy, keyed on a tool's KIND rather than its name, so a tool we
 * have never heard of is covered by whatever its kind already says about it
 * (see verb-group.ts) instead of falling through a chain of name checks.
 */
const PEEK_BY_KIND: Record<string, PeekEnd> = {
    command: "tail",
    shell: "tail",
    subagent: "tail",
    edit: "hunk",
    file: "none",
    // A question or a plan is a surface the user acts on — both render their
    // own way and neither is ever reduced to a preview.
    ask: "none",
    plan: "none",
    search: "head",
    dir: "head",
    web: "head",
    memory: "head",
    data: "head",
    todo: "head",
    artifact: "head",
    mcp: "head",
    extension: "head",
};

export interface ToolPeek {
    /** The lines to show, in order. Never more than the caller's budget. */
    lines: string[];
    /** Body lines NOT shown — what expanding the row would add. */
    hidden: number;
}

const NO_PEEK: ToolPeek = { lines: [], hidden: 0 };

/** Body with leading and trailing blank lines dropped; interior ones kept,
 * since a blank inside a peek is real spacing the output chose. */
function trimBlanks(body: string[]): string[] {
    let start = 0;
    let end = body.length;
    while (start < end && body[start].trim() === "") start++;
    while (end > start && body[end - 1].trim() === "") end--;
    return body.slice(start, end);
}

/** The first changed lines of a diff — `+`/`-` only, context skipped. */
function hunkPeek(body: string[], max: number): string[] {
    const changed: string[] = [];
    for (const l of body) {
        if (l.startsWith("+") || l.startsWith("-")) changed.push(l);
        if (changed.length === max) break;
    }
    return changed;
}

/**
 * The few lines of `output` a folded row should show, and how many it leaves
 * behind.
 *
 * `max` is a budget in LINES OF SOURCE, not rows on screen — the caller
 * truncates rather than wraps, so a long line costs one row like any other and
 * the budget holds.
 *
 * A failure always peeks its tail, whatever the tool: an error whose text is
 * reachable only by expanding the row is the exact failure this exists to fix,
 * and errors end with the thing that went wrong.
 */
export function toolPeek(
    toolName: string,
    output: string,
    isError: boolean,
    max: number,
    args: Record<string, unknown> = {},
): ToolPeek {
    if (max <= 0 || !output.trim()) return NO_PEEK;
    const { body } = split(output);
    const trimmed = trimBlanks(body);
    if (trimmed.length === 0) return NO_PEEK;

    const end: PeekEnd = isError ? "tail" : (PEEK_BY_KIND[kindIdOf(toolName)] ?? "head");
    if (end === "none") return NO_PEEK;

    if (end === "hunk") {
        const lines = hunkPeek(trimmed, max);
        if (lines.length > 0) return { lines, hidden: Math.max(0, trimmed.length - lines.length) };
        // No diff to hunk over. For a NEW file that is not a failure of the
        // rule — there was nothing to diff against — and the content the call
        // wrote is the one thing the result text never carries, so it comes
        // from the argument instead.
        const content = typeof args.content === "string" ? args.content.replace(/\n$/, "") : "";
        if (!content) return NO_PEEK;
        const all = content.split("\n");
        return { lines: all.slice(0, max), hidden: Math.max(0, all.length - max) };
    }

    const lines = end === "tail" ? trimmed.slice(-max) : trimmed.slice(0, max);
    return { lines, hidden: Math.max(0, trimmed.length - lines.length) };
}
