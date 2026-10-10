/**
 * A loop tool call, as a web row.
 *
 * The information is the terminal's — loop's own per-tool grammar, the status
 * that its diamond carries, `read`'s line range and numbered output, `edit`'s
 * diff, the live file content while a `write` streams, a subagent's agent and
 * run stats. The presentation is not: a terminal has one font and sixteen
 * colours, and reproducing that here (monospace everything, a `◆` in the
 * gutter) made the app look like a terminal emulator rather than read like an
 * interface.
 *
 * So: the tool is named in the UI font with an icon for what it does, the
 * argument stays monospace because it is a path or a command, and the output
 * is a proper code surface with a real line-number column and tinted diff
 * rows. Every fact the terminal shows is still here.
 *
 * `plan` never reaches this row: loop delivers a plan as a tool call whose
 * input is the document, and the handler routes it to the plan card — the same
 * split the terminal's own renderer makes.
 */
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  DatabaseIcon,
  EyeIcon,
  FolderIcon,
  GlobeIcon,
  SearchIcon,
  SparklesIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useEffect, useState, type KeyboardEvent } from "react";
import type { ScopedThreadRef } from "@loop/contracts";

import { cn } from "../../lib/utils";
import {
  formatDuration,
  formatTaskStatus,
  formatToolArgs,
  readGutterPrefixes,
  readLineRangeText,
  visibleSubagentSteps,
} from "./loopToolSummary";
import { ArtifactChip } from "./ArtifactChip";
import { artifactResultSummary, parseArtifactResult } from "./artifacts";
import type { LoopSubagentStep, LoopToolEntry } from "./loopEntry";
import { LoopTeamToolRow, TEAM_TOOL_NAMES } from "./LoopTeam";

/** Live tail while input streams — the terminal's `thinking.liveTailLines`. */
const LIVE_TAIL_LINES = 3;

/**
 * Output lines shown before the row offers the rest.
 * `uiStyle().tool.collapsedLines` in the terminal, which is 6.
 */
const COLLAPSED_OUTPUT_LINES = 6;

type ToolState = "running" | "success" | "error" | "interrupted";

function toolState(tool: LoopToolEntry): ToolState {
  if (tool.isError && !tool.isPartial) return "error";
  if (tool.isPartial) return "running";
  if (tool.interrupted) return "interrupted";
  return "success";
}

/** What the tool does, so the row is scannable without reading it. */
function ToolIcon({ name, state }: { name: string; state: ToolState }) {
  const className = cn(
    "size-3.5 shrink-0",
    state === "error"
      ? "text-destructive"
      : state === "running"
        ? "text-warning"
        : state === "interrupted"
          ? "text-muted-foreground/40"
          : "text-muted-foreground/70",
  );
  if (state === "running")
    return <CircleDashedIcon aria-hidden className={cn(className, "animate-spin")} />;
  if (state === "error") return <CircleAlertIcon aria-hidden className={className} />;
  switch (name) {
    case "bash":
      return <TerminalIcon aria-hidden className={className} />;
    case "read":
      return <EyeIcon aria-hidden className={className} />;
    case "write":
    case "edit":
      return <SquarePenIcon aria-hidden className={className} />;
    case "grep":
    case "find":
      return <SearchIcon aria-hidden className={className} />;
    case "ls":
      return <FolderIcon aria-hidden className={className} />;
    case "websearch":
      return <GlobeIcon aria-hidden className={className} />;
    case "sql":
      return <DatabaseIcon aria-hidden className={className} />;
    case "task":
      return <BotIcon aria-hidden className={className} />;
    case "skill":
      return <SparklesIcon aria-hidden className={className} />;
    default:
      return <WrenchIcon aria-hidden className={className} />;
  }
}

function lastLines(text: string, count: number): string[] {
  const lines = text.split("\n");
  return lines.length > count ? lines.slice(-count) : lines;
}

/**
 * A written file's content, rendered as the additions it is.
 *
 * Covers the two cases where `write` reports no diff of its own:
 *
 * - A NEW file. There is nothing to diff against, and the content is already
 *   in the model's context as the call's own argument, so the tool does not
 *   send it back. The UI is under no such constraint — the input is right here.
 * - A RELOADED thread. `write` keeps its diff out of the model's context via
 *   `toModelOutput`, and the AI SDK persists the model-facing value — so the
 *   diff exists on the live `tool-result` event and nowhere else. Replaying
 *   from history, the content is all that survives.
 *
 * Without this a write is a bare "wrote 812 bytes" sitting next to an `edit`
 * that shows every line it touched. Formatted exactly like
 * `generateDiffString` (`+<lineNum> <text>`) so the tinting below cannot tell
 * a reconstruction from the real thing.
 */
function writeContentAdditions(tool: LoopToolEntry): string[] | null {
  if (tool.name !== "write" || tool.isError || tool.isPartial) return null;
  const output = tool.output;
  // A live overwrite carries its own real diff, and a no-op overwrite must not
  // be dressed up as one — both already say everything there is to say.
  if (output === undefined || output.includes("\n+") || output.endsWith("(content unchanged)")) {
    return null;
  }
  const content = tool.args.content;
  if (typeof content !== "string" || content === "") return null;
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, index) => `+${String(index + 1).padStart(width, " ")} ${line}`);
}

/**
 * The diff a REPLAYED edit no longer carries.
 *
 * Same shape of gap as `writeContentAdditions` above: `edit` keeps its diff out
 * of the model's context via `toModelOutput`, the AI SDK persists the
 * model-facing value, and so the real diff rides the live `tool-result` event
 * and exists nowhere else. Reloading the thread, the call's own arguments are
 * all that survive — and they are enough, since the model sent every
 * oldText/newText pair.
 *
 * Line numbers are deliberately absent. The arguments never said where in the
 * file the blocks landed, and invented numbers next to a live edit's real ones
 * would be read as real.
 */
function editReplayDiff(tool: LoopToolEntry, output: string | undefined): string[] | null {
  if (tool.name !== "edit" || tool.isError || tool.isPartial) return null;
  // A live edit carries its own real diff — never dress one up twice.
  if (!output || /^[+-]/m.test(output)) return null;
  const edits = tool.args.edits;
  if (!Array.isArray(edits)) return null;
  const lines: string[] = [output];
  for (const edit of edits as Array<{ oldText?: unknown; newText?: unknown }>) {
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") return null;
    for (const line of edit.oldText.split("\n")) lines.push(`-${line}`);
    for (const line of edit.newText.split("\n")) lines.push(`+${line}`);
  }
  return lines.length > 1 ? lines : null;
}

/** A code surface, the way the rest of the app renders code. */
function OutputSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 ml-[22px] overflow-hidden rounded-md border border-border/50 bg-muted/25">
      {children}
    </div>
  );
}

const OutputBody = memo(function OutputBody({
  tool,
  lines,
}: {
  tool: LoopToolEntry;
  lines: readonly string[];
}) {
  const isDiff = !tool.isError && (tool.name === "edit" || tool.name === "write");
  // `read` output carries the file's absolute line numbers, starting at the
  // call's offset — a preview renumbered from 1 cannot be matched back to the
  // file it came from. Nothing else gets a gutter.
  const gutters =
    tool.name === "read" && !tool.isError
      ? readGutterPrefixes(lines, tool.args)
      : lines.map(() => "");
  const gutterWidth = gutters.reduce((widest, value) => Math.max(widest, value.length), 0);

  return (
    <div className="overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.55]">
      {lines.map((line, index) => (
        // Output lines have no identity of their own; the index is the line.
        // eslint-disable-next-line react/no-array-index-key
        <div
          className={cn(
            "flex px-2",
            isDiff && line.startsWith("+") && "bg-success/10",
            isDiff && line.startsWith("-") && "bg-destructive/10",
          )}
          key={index}
        >
          {gutterWidth > 0 ? (
            <span
              className="shrink-0 select-none pr-3 text-right text-muted-foreground/40 tabular-nums"
              style={{ width: `${gutterWidth}ch` }}
            >
              {gutters[index]}
            </span>
          ) : null}
          <span
            className={cn(
              "min-w-0 whitespace-pre-wrap break-words",
              tool.isError
                ? "text-destructive/90"
                : isDiff && line.startsWith("+")
                  ? "text-success"
                  : isDiff && line.startsWith("-")
                    ? "text-destructive"
                    : "text-foreground/70",
            )}
          >
            {line === "" ? " " : line}
          </span>
        </div>
      ))}
    </div>
  );
});

/**
 * A clock that ticks while a call is open.
 *
 * A subagent can run for minutes, and a row whose elapsed time only appears
 * once the call returns reads as frozen the whole time it matters. One second
 * is the terminal's own pulse; the interval is not started at all for a
 * settled call, so a finished transcript re-renders nothing.
 */
function useElapsedMs(startedAt: number | undefined, running: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  if (startedAt === undefined) return undefined;
  return Math.max(0, now - startedAt);
}

/** Steps of a subagent's log kept visible before the row offers the rest. */
const COLLAPSED_ACTIVITY_STEPS = 5;

/**
 * What a subagent has been doing, nested under its task row.
 *
 * The terminal draws this inside the task tool's box as `> tool args` lines
 * with the agent's prose in between, and the nesting is what makes a long run
 * legible. Rendered as a rail rather than a code surface: a tool name is UI
 * text, its argument is a path or a command (mono), and the agent's prose is
 * prose — the same split the rest of these rows make.
 */
const SubagentLog = memo(function SubagentLog({
  steps,
  dropped,
  cwd,
  running,
}: {
  steps: readonly LoopSubagentStep[];
  dropped: number;
  cwd: string;
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // While it runs the tail is what matters — that is where it is now. Once it
  // is done the whole log is history and the head is as interesting as the
  // tail, so the same control just opens it.
  const hidden = Math.max(0, steps.length - COLLAPSED_ACTIVITY_STEPS);
  const shown = expanded ? steps : steps.slice(steps.length - COLLAPSED_ACTIVITY_STEPS);

  return (
    <div className="mt-1 ml-[22px] border-border/50 border-l pl-3">
      {dropped > 0 && expanded ? (
        <div className="py-0.5 text-[11px] text-muted-foreground/45">
          {dropped} earlier step{dropped === 1 ? "" : "s"} not kept
        </div>
      ) : null}
      {hidden > 0 ? (
        <button
          className="cursor-pointer py-0.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show less" : `Show ${hidden} earlier step${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {shown.map((step, index) =>
        step.kind === "tool" ? (
          // Steps have no identity of their own and the log is append-only,
          // so position is the key.
          // eslint-disable-next-line react/no-array-index-key
          <div className="flex items-baseline gap-1.5 py-0.5 text-[12px]" key={index}>
            <span className="shrink-0 text-muted-foreground/70">{step.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground/50">
              {/* A replayed run carries loop's own formatted line; a live one
                  carries the raw input and is formatted here. */}
              {step.summary ?? formatToolArgs(step.name, argsOf(step.input), cwd)}
            </span>
          </div>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <p
            className={cn(
              "py-0.5 text-[12px] leading-[1.55] whitespace-pre-wrap",
              // Its reasoning is not its answer, and a log that renders both
              // the same way reads as the subagent contradicting itself.
              step.kind === "thinking"
                ? "text-muted-foreground/45 italic"
                : "text-muted-foreground/60",
            )}
            key={index}
          >
            {step.text.trim()}
          </p>
        ),
      )}
      {running ? <div className="py-0.5 text-[11px] text-muted-foreground/40">working…</div> : null}
    </div>
  );
});

/** A subagent tool's input, which crosses the wire as `unknown`. */
function argsOf(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export const LoopToolRow = memo(function LoopToolRow(props: {
  threadRef: ScopedThreadRef | null;
  tool: LoopToolEntry;
  workspaceRoot: string | undefined;
}) {
  // Thread teams draw their own cards: live thread states, names for ids.
  if (TEAM_TOOL_NAMES.has(props.tool.name)) return <LoopTeamToolRow threadRef={props.threadRef} tool={props.tool} />;
  return <LoopToolRowBody {...props} />;
});

const LoopToolRowBody = memo(function LoopToolRowBody({
  threadRef,
  tool,
  workspaceRoot,
}: {
  /** Which thread's right panel an artifact card should open into. */
  threadRef: ScopedThreadRef | null;
  tool: LoopToolEntry;
  workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const state = toolState(tool);
  const cwd = workspaceRoot ?? "";
  const isTask = tool.name === "task";

  const summary = formatToolArgs(tool.name, tool.args, cwd);
  const range = tool.name === "read" ? readLineRangeText(tool.args) : "";

  // `task <agent> · <status> · <prompt snippet>` — a subagent's identity line.
  const agent = typeof tool.args.agent === "string" ? tool.args.agent : "default";
  const snippet =
    typeof tool.args.prompt === "string"
      ? (tool.args.prompt.split("\n")[0] ?? "").slice(0, 60)
      : "";
  // Every running call, not only a subagent's. A `bash` that compiles for
  // ninety seconds and a `read` that returns instantly render identically
  // otherwise — both a static "running" — and the whole complaint about this
  // view is not being able to tell that something is still happening.
  const elapsedMs = useElapsedMs(tool.startedAt, tool.isPartial);
  const taskStatus = formatTaskStatus({
    isPartial: tool.isPartial,
    interrupted: tool.interrupted === true,
    isError: tool.isError,
    ...(tool.statusText === undefined ? {} : { statusText: tool.statusText }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    stats: tool.stats,
  });

  const name = isTask ? `task ${agent}` : tool.name;
  // The prompt is what the subagent was ASKED, so it belongs on the identity
  // line; the run's state moves to the right edge where every other row keeps
  // it, instead of being buried in front of the prompt.
  const detail = isTask ? snippet : summary;
  const status = isTask
    ? taskStatus
    : tool.isPartial
      ? [
          tool.statusText || "running",
          ...(elapsedMs === undefined ? [] : [formatDuration(elapsedMs)]),
        ].join(" · ")
      : tool.interrupted
        ? "interrupted"
        : "";

  // A settled subagent's closing text IS its report, and loop keeps both — so
  // without this the answer renders twice, dim in the log and again below it.
  const activity = visibleSubagentSteps(tool.activity ?? [], !tool.isPartial, tool.output);
  // An `artifact` result carries a card payload after its summary. Render the
  // card instead of the raw output — the JSON is for this component, not to be
  // read — and keep only the human half as text.
  const artifactCard = parseArtifactResult(tool.output);
  const visibleOutput =
    artifactCard && tool.output ? artifactResultSummary(tool.output) : tool.output;
  const outputLines =
    writeContentAdditions(tool) ??
    editReplayDiff(tool, visibleOutput) ??
    (visibleOutput ? visibleOutput.split("\n") : []);
  // While the input is still arriving there is no output — the growing file
  // content stands in, which is how a long `write` shows progress.
  const streamingLines =
    tool.isPartial && tool.streamingContent && !tool.output
      ? lastLines(tool.streamingContent, LIVE_TAIL_LINES)
      : null;
  const shownLines = expanded ? outputLines : outputLines.slice(0, COLLAPSED_OUTPUT_LINES);
  const hiddenCount = outputLines.length - shownLines.length;
  const canExpand = hiddenCount > 0 || (expanded && outputLines.length > COLLAPSED_OUTPUT_LINES);

  const toggle = () => setExpanded((value) => !value);

  return (
    <div className="py-px">
      <div
        aria-expanded={canExpand ? expanded : undefined}
        className={cn(
          "group flex items-center gap-2 rounded-md px-1 py-1 transition-colors",
          canExpand &&
            "cursor-pointer hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
        onClick={canExpand ? toggle : undefined}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (!canExpand) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
        {...(canExpand ? { role: "button" as const, tabIndex: 0 } : {})}
      >
        <ToolIcon name={tool.name} state={state} />
        <span
          className={cn(
            "shrink-0 font-medium text-[13px]",
            state === "error" ? "text-destructive" : "text-foreground/85",
          )}
        >
          {name}
        </span>
        {detail ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground/75">
            {detail}
            {range ? <span className="text-warning/90">{range}</span> : null}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {status ? (
          <span className="shrink-0 text-[11px] text-muted-foreground/55">{status}</span>
        ) : null}
        {canExpand ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/45">
            {expanded ? null : <span className="tabular-nums">{outputLines.length} lines</span>}
            {expanded ? (
              <ChevronDownIcon aria-hidden className="size-3.5" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3.5" />
            )}
          </span>
        ) : null}
      </div>

      {/* Outside the collapsible body: the card is the point of the row, so it
          must not be hidden behind a disclosure the reader has to find. */}
      {artifactCard ? <ArtifactChip artifact={artifactCard} threadRef={threadRef} /> : null}

      {streamingLines ? (
        <OutputSurface>
          <pre className="overflow-x-auto px-2 py-1 font-mono text-[11.5px] text-foreground/60 leading-[1.55] whitespace-pre-wrap break-words">
            {streamingLines.join("\n")}
          </pre>
        </OutputSurface>
      ) : null}

      {activity.length > 0 ? (
        <SubagentLog
          cwd={cwd}
          dropped={tool.droppedActivity ?? 0}
          running={tool.isPartial}
          steps={activity}
        />
      ) : null}

      {shownLines.length > 0 ? (
        // A subagent's result is a written report, not program output, so it
        // reads as prose rather than in the code surface every other tool
        // uses. Same rule as the thinking row.
        isTask && !tool.isError ? (
          <div className="mt-1 ml-[22px] border-border/50 border-l pl-3">
            <p className="whitespace-pre-wrap py-0.5 text-[12.5px] text-foreground/70 leading-[1.6]">
              {shownLines.join("\n")}
            </p>
            {canExpand ? (
              <button
                className="cursor-pointer py-0.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground"
                onClick={toggle}
                type="button"
              >
                {expanded ? "Show less" : `Show ${hiddenCount} more lines`}
              </button>
            ) : null}
          </div>
        ) : (
          <OutputSurface>
            <OutputBody lines={shownLines} tool={tool} />
            {canExpand ? (
              <button
                className="w-full cursor-pointer border-border/40 border-t px-2 py-1 text-left text-[11px] text-muted-foreground/60 hover:bg-accent/20 hover:text-muted-foreground"
                onClick={toggle}
                type="button"
              >
                {expanded ? "Show less" : `Show ${hiddenCount} more lines`}
              </button>
            ) : null}
          </OutputSurface>
        )
      ) : null}
    </div>
  );
});
