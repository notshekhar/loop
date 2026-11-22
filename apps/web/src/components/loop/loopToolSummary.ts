/**
 * How a loop tool call reads on one line.
 *
 * This is a port of `packages/cli/src/interactive/ui/tool-summary.ts`, which
 * the TUI calls its single source of truth for summarizing a call — the live
 * tool box and the /tree row both go through it so they describe a call
 * identically. The web is a third surface and has to agree with the other two,
 * so the rules are reproduced here rather than reinvented: a `read` row says
 * `read src/app.ts:120-180` in the terminal and must say the same thing here.
 *
 * Ported rather than imported: the CLI module reaches for the extension host
 * and the ANSI theme, neither of which exists in a browser. Only the pure
 * grammar comes across, uncolored — the components apply their own styling.
 *
 * KEEP IN SYNC with the CLI module. If loop grows a tool, both need the case.
 */

/** Shorten an absolute path under `cwd` to a repo-relative one (or `.` for cwd). */
function rel(value: unknown, cwd: string): string {
  if (typeof value !== "string") return "";
  return value.startsWith(cwd) ? value.slice(cwd.length).replace(/^\//, "") || "." : value;
}

/**
 * One-line argument summary for a tool call. Empty string when there is
 * nothing useful to show (e.g. a pending call whose input has not streamed).
 *
 * The extension seam the CLI has is deliberately absent: an extension's
 * renderer is CLI-side code that returns ANSI, so a tool loop does not ship
 * falls to the JSON default here.
 */
export function formatToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string {
  if (Object.keys(args).length === 0) return "";
  const a = args;
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return rel(a.path ?? a.file_path ?? a.filePath, cwd);
    case "bash": {
      const command = typeof a.command === "string" ? a.command : "";
      const firstLine = command.split("\n")[0] ?? "";
      return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
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
      const connection = typeof a.connectionId === "string" ? a.connectionId : "";
      const query = typeof a.query === "string" ? a.query.replace(/\s+/g, " ").trim() : "";
      const short = query.length > 60 ? `${query.slice(0, 57)}…` : query;
      return [connection, short].filter(Boolean).join(" · ");
    }
    case "code": {
      // The script's first real line; the whole script shows when the row is opened.
      const code = typeof a.code === "string" ? a.code : "";
      const first = (code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//")) ?? "").trim();
      return first.length > 80 ? `${first.slice(0, 77)}…` : first;
    }
    case "plan": {
      // The plan body renders as markdown below the title — the summary is its
      // first heading, never the raw JSON blob.
      const plan = typeof a.plan === "string" ? a.plan : "";
      const heading = (plan.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
      return heading.length > 80 ? `${heading.slice(0, 77)}…` : heading;
    }
    default:
      return describeUnknownTool(a, cwd);
  }
}

/**
 * Arguments an unknown tool most likely describes itself with, best first.
 * Ordered so a tool taking both a path and a query reads as the path.
 */
const DESCRIPTIVE_KEYS = [
  "path",
  "file_path",
  "filePath",
  "file",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "name",
  "title",
  "id",
  "prompt",
  "message",
  "text",
] as const;

function clampToRow(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}

/**
 * A row for a tool loop does not ship — anything an extension or an MCP server
 * contributes.
 *
 * The CLI asks the extension to render its own summary; that hook returns ANSI
 * and runs CLI-side, so it cannot be called from a browser. Rather than drop
 * such a tool to a raw `{"a":1,…}` blob, this reads it the way the built-in
 * cases do: the argument most likely to say what the call is about, then a lone
 * string argument (which names itself), and only then the JSON.
 */
function describeUnknownTool(args: Record<string, unknown>, cwd: string): string {
  for (const key of DESCRIPTIVE_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return clampToRow(rel(value, cwd));
    }
  }
  const strings = Object.entries(args).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
  );
  const lone = strings.length === 1 ? strings[0] : undefined;
  if (lone) return clampToRow(rel(lone[1], cwd));
  // Scalars read better as `key=value` pairs than as JSON punctuation.
  const scalars = Object.entries(args).filter(
    ([, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
  if (scalars.length > 0 && scalars.length === Object.keys(args).length) {
    return clampToRow(scalars.map(([key, value]) => `${key}=${String(value)}`).join(" "));
  }
  const json = JSON.stringify(args);
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
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
 * output line (empty string = do not number this line).
 *
 * The numbering starts at the call's `offset`, not at 1: an offset read shows
 * the file's real line numbers, which is the whole point — a preview that
 * restarts at 1 cannot be matched back to the file it came from.
 *
 * The tool appends its own `[Showing lines … ]` / `[N more lines … ]` notice
 * after a blank line, and a whole-result notice (image file, over-limit line)
 * is a message rather than a body — neither gets a number.
 *
 * One deliberate divergence from the CLI: it appends two spaces to each number
 * because a terminal line is a string. Here the gutter is its own column, so
 * the padding is CSS and the number comes back bare.
 */
export function readGutterPrefixes(
  lines: readonly string[],
  args: Record<string, unknown>,
): string[] {
  if (lines.length === 0) return [];
  if (lines.length === 1 && READ_NOTICE_RE.test((lines[0] ?? "").trim())) return [""];
  const base = typeof args.offset === "number" ? args.offset : 1;
  let bodyEnd = lines.length;
  if (
    bodyEnd >= 2 &&
    READ_NOTICE_RE.test((lines[bodyEnd - 1] ?? "").trim()) &&
    (lines[bodyEnd - 2] ?? "").trim() === ""
  ) {
    bodyEnd -= 2;
  }
  const width = String(base + Math.max(0, bodyEnd - 1)).length;
  return lines.map((_, index) => (index < bodyEnd ? `${String(base + index).padStart(width)}` : ""));
}

/**
 * Full one-line invocation label for a resolved tool call: `toolName summary`.
 * `task` shows its agent + prompt snippet; `read` appends its line range.
 */
export function formatToolInvocation(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string {
  if (toolName === "task") {
    const agent = typeof args.agent === "string" ? args.agent : "default";
    const prompt = typeof args.prompt === "string" ? (args.prompt.split("\n")[0] ?? "").slice(0, 60) : "";
    return prompt ? `task ${agent}: ${prompt}` : `task ${agent}`;
  }
  const summary = formatToolArgs(toolName, args, cwd);
  const range = toolName === "read" ? readLineRangeText(args) : "";
  return summary ? `${toolName} ${summary}${range}` : toolName;
}

/** `0.5s` under 10s, `41s` under a minute, `1m23s` beyond — noir's fmtSeconds. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  const tenth = Math.round(seconds * 10) / 10;
  if (tenth < 10) return `${tenth.toFixed(1)}s`;
  // Branch on the ROUNDED value: branching on the raw one printed "60s" for
  // 119.7s (minutes floored raw, seconds rounded up past the boundary).
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  return `${Math.floor(rounded / 60)}m${String(rounded % 60).padStart(2, "0")}s`;
}

/**
 * The subagent log with its closing remarks removed, once the run has settled.
 *
 * A subagent's last words ARE its report: loop streams them as
 * `subagent-delta` and then hands the same text back as the tool's result, and
 * the transcript persists both (`activity`'s trailing text part, and
 * `result`). Rendering both put the answer on screen twice — once dim inside
 * the log, once as the report directly under it. The terminal has the same two
 * copies and shows one: `tool-result` composes the buffer into the final
 * display and clears it.
 *
 * Only trailing text is dropped, and only when the report already contains it:
 * a subagent that narrates mid-run ("checking the router") said something the
 * report does not, and that line is worth keeping.
 */
export function visibleSubagentSteps<
  T extends { readonly kind: string; readonly text?: string },
>(steps: readonly T[], settled: boolean, output: string | undefined): readonly T[] {
  if (!settled || !output) return steps;
  const report = output.trim();
  if (report === "") return steps;
  let end = steps.length;
  while (end > 0) {
    const step = steps[end - 1]!;
    const text = step.kind === "text" ? (step.text ?? "").trim() : "";
    if (text === "" || !report.includes(text)) break;
    end -= 1;
  }
  return end === steps.length ? steps : steps.slice(0, end);
}

/**
 * A subagent run's title tail: `done · 12 steps · 41s · $0.0430` when it has
 * ended, `read src/app.ts · step 3 · 14s · $0.0121` while it is running.
 *
 * The running form is the terminal's (`subagent-stream.ts` `statusFor`), and it
 * is the point of the row: a `task` that says nothing but "running" for two
 * minutes tells you neither what it is doing nor whether it is stuck. The
 * elapsed part needs `elapsedMs` from the caller — `stats.durationMs` does not
 * exist until the call returns.
 */
export function formatTaskStatus(input: {
  readonly isPartial: boolean;
  readonly interrupted: boolean;
  readonly isError: boolean;
  readonly statusText?: string;
  readonly elapsedMs?: number;
  readonly stats?: { steps?: number; durationMs?: number; usd?: number } | undefined;
}): string {
  const stats = input.stats;
  if (input.isPartial) {
    const parts = [input.statusText || "running"];
    if (stats?.steps) parts.push(`step ${stats.steps}`);
    if (input.elapsedMs !== undefined) parts.push(formatDuration(input.elapsedMs));
    if (stats?.usd !== undefined) parts.push(`$${stats.usd.toFixed(4)}`);
    return parts.join(" · ");
  }
  if (input.interrupted) return "interrupted";
  if (input.isError) return "failed";
  const parts = ["done"];
  if (stats?.steps) parts.push(`${stats.steps} step${stats.steps === 1 ? "" : "s"}`);
  if (stats?.durationMs !== undefined) parts.push(formatDuration(stats.durationMs));
  if (stats?.usd !== undefined) parts.push(`$${stats.usd.toFixed(4)}`);
  return parts.join(" · ");
}
