/**
 * A loop session, rendered as the conversation the UI knows how to draw.
 *
 * Two sources are merged. `session.history` is the transcript loop has
 * persisted — authoritative, but only written when a turn ends. The in-flight
 * turn comes from `liveTurn.ts`, fed by loop's `session.event` stream. A thread
 * is therefore "everything on disk, plus the turn currently being written".
 *
 * The mapping that makes this work without any new loop protocol:
 *
 *   loop text-delta / text parts   -> OrchestrationMessage(role: assistant)
 *   loop reasoning                 -> activity kind "task.progress", which is
 *                                     what the work log renders as thinking
 *   loop tool calls                -> activity tone "tool"
 *   loop's `plan` tool call        -> OrchestrationProposedPlan, since its
 *                                     `input.plan` IS the markdown document
 *                                     the plan card renders
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  OrchestrationThread as OrchestrationThreadSchema,
  type OrchestrationThreadStreamItem,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  clientThreadIdFor,
  draftIntent,
  loopSessionIdFor,
  recentUserMessageId,
  turnOptionsFor,
} from "./dispatch.ts";
import { formatError } from "./formatError.ts";
import { toInstanceId } from "./ids.ts";
import { pinSession } from "./sessionPaging.ts";
import {
  adoptRunningTurn,
  clearLiveTurn,
  confirmLiveTurnRunning,
  endLiveTurn,
  forgetEventSeq,
  syncEventSeq,
  lastEventSeq,
  liveTurnIsQuiet,
  onLiveTurnChange,
  readLiveTurn,
  type LiveToolCall,
  type LiveSubagentStep,
} from "./liveTurn.ts";
import { parsePartialInput } from "./streamingInput.ts";
import { defaultLoopHost, type LoopHost } from "../transport.ts";

/** `kind` the work log turns into a thinking-toned row. */
const THINKING_ACTIVITY_KIND = "task.progress";

/** loop's tool for proposing a plan; its input carries the whole document. */
const PLAN_TOOL = "plan";

interface LoopEntry {
  readonly type: string;
  readonly ts: number;
  readonly id?: string;
  readonly role?: "user" | "assistant" | "tool";
  readonly content?: unknown;
  readonly interrupted?: boolean;
  readonly name?: string;
}

interface LoopHistory {
  readonly sessionId: string;
  readonly info: { readonly cwd: string; readonly provider: string; readonly model: string; readonly createdAt: number };
  /**
   * The model/provider the session is running on NOW, which is not
   * `info.model` — that is the one it was created with, and every `/model`
   * switch (in the terminal or here) leaves it behind. Pre-selecting the
   * composer from `info` therefore undid the switch on the next render, so the
   * picker appeared to refuse to change models mid-session. Optional: an older
   * loop does not report them.
   */
  readonly model?: string;
  readonly provider?: string;
  readonly name?: string;
  readonly entries: readonly LoopEntry[];
  /** Present when `entries` is only the branch after this entry (asked for
   * with `afterEntryId`); absent when it is the whole branch. */
  readonly tail?: { readonly afterEntryId: string };
  readonly seq: number;
  readonly running: boolean;
}

interface ContentPart {
  readonly type: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly input?: unknown;
  readonly args?: unknown;
  readonly output?: unknown;
  readonly result?: unknown;
}

const decodeThread = Schema.decodeUnknownEffect(OrchestrationThreadSchema);

const iso = (epochMs: number) => new Date(epochMs).toISOString();

function isoFromMicros(micros: number): string {
  const base = new Date(Math.floor(micros / 1000)).toISOString();
  return `${base.slice(0, -1)}${String(micros % 1000).padStart(3, "0")}Z`;
}

/**
 * Timestamps that preserve the order things were emitted in.
 *
 * The terminal has no ordering problem: it appends one block per event to a
 * single list, so the transcript IS the stream. This app has to hand back the
 * contract's three separate arrays — messages, activities, plans — which the
 * timeline merges by sorting on `createdAt` alone. Aggregating into those
 * buckets and stamping each from its source timestamp loses the interleaving
 * outright: loop stamps every part of one assistant message with the entry's
 * single `ts`, and a live turn has only the moment it began. Both collapse to
 * "the whole answer, then every tool it called".
 *
 * So the walk is single-pass and this hands out a strictly increasing stamp at
 * each emit — no earlier than the source's own time, always after the previous
 * block. Sorting then reproduces the walk exactly. ISO 8601 allows the extra
 * precision and string comparison still orders it correctly.
 */
class EmitOrder {
  #lastMicros = 0;

  next(epochMs: number): string {
    const micros = Math.max(Math.floor(epochMs) * 1000, this.#lastMicros + 1);
    this.#lastMicros = micros;
    return isoFromMicros(micros);
  }

  /** The stamp last handed out, for anything that must not sort before it. */
  current(): string {
    return isoFromMicros(this.#lastMicros);
  }
}

function partsOf(content: unknown): readonly ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as readonly ContentPart[];
  return [];
}

function textOf(content: unknown): string {
  return partsOf(content)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * loop's attachment sentinel, as it appears in a PERSISTED user message.
 *
 * The RPC server writes each attachment to a temp file and appends
 * `[image:<path>]` to the input (`writeAttachmentPayloads`), and `runTurn`
 * persists that input verbatim — so the transcript's copy of the message
 * carries the token, not the picture. Matches core's own `BRACKET_RE`
 * (`packages/core/src/agent/images.ts`), extensions included.
 */
const ATTACHMENT_SENTINEL_RE =
  /\n?\[image:([^\]]+\.(?:png|jpe?g|gif|webp|bmp|pdf))\]/gi;

const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
};

/**
 * Lift a replayed user message's attachments out of its text.
 *
 * Two things go wrong without this, and the second is the worse one:
 *
 *   - the bubble renders `[image:/var/folders/…/loop-attach-9f2c.png]` as
 *     prose, which is the sentinel doing its job in a surface that was never
 *     meant to see it;
 *   - the message DOUBLES. The optimistic copy is matched to the transcript by
 *     exact text (`recentUserMessageId`), and the text the composer sent has no
 *     sentinel in it — loop appends that on the way in — so the two never
 *     matched and the send appeared twice as soon as anything was attached.
 *
 * The bytes are not recovered: the temp file may be long gone and the renderer
 * cannot read outside the workspace anyway. The chip falls back to the name,
 * which is the same thing every surface here already does for an attachment it
 * has no preview for.
 */
function splitUserAttachments(raw: string): {
  text: string;
  attachments: ReadonlyArray<{
    type: "image" | "file";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
} {
  ATTACHMENT_SENTINEL_RE.lastIndex = 0;
  if (!ATTACHMENT_SENTINEL_RE.test(raw)) return { text: raw, attachments: [] };

  const attachments: Array<{
    type: "image" | "file";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }> = [];
  ATTACHMENT_SENTINEL_RE.lastIndex = 0;
  const text = raw.replace(ATTACHMENT_SENTINEL_RE, (_match, path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const mimeType = ATTACHMENT_MIME_BY_EXT[extension] ?? "application/octet-stream";
    attachments.push({
      type: mimeType === "application/pdf" ? "file" : "image",
      // The id only has to be stable within the message and match the
      // contract's `^[a-z0-9_-]+$`; the temp file's own name is neither
      // guaranteed to be one nor meaningful to anybody.
      id: `attachment-${attachments.length}`,
      name,
      mimeType,
      // Unknown, and honestly so: nothing here has the file to measure.
      sizeBytes: 0,
    });
    return "";
  });
  return { text: text.trim(), attachments };
}

/** A one-line summary for a tool row; the full input goes in the payload. */
function toolSummary(name: string, input: unknown): string {
  const record = input as Record<string, unknown> | undefined;
  const candidate =
    record?.["command"] ?? record?.["file_path"] ?? record?.["path"] ?? record?.["pattern"];
  if (typeof candidate === "string" && candidate.trim() !== "") {
    const flat = candidate.replace(/\s+/g, " ").trim();
    return `${name} ${flat.length > 90 ? `${flat.slice(0, 89)}…` : flat}`;
  }
  return name || "tool";
}

function detailOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

interface Accumulator {
  readonly messages: unknown[];
  readonly activities: unknown[];
  readonly plans: unknown[];
  /**
   * Tool call ids the transcript already holds.
   *
   * The live overlay retires as a whole, and only on evidence that the
   * transcript caught up with its TEXT — so a turn whose reply was empty, or
   * whose text differs by a trailing newline, leaves the overlay in place
   * while history also has the same calls. Both then render: one settled row
   * and one stuck on "running" forever. Matching per call id is exact, and
   * loop uses the same toolCallId on both sides.
   */
  readonly seenToolCallIds: Set<string>;
  /** Reasoning text the transcript already holds, for the same reason. */
  readonly seenThinking: Set<string>;
  /**
   * Assistant text runs the transcript already holds.
   *
   * Text was the one block type with no per-item dedupe: it relied entirely on
   * the overlay retiring as a whole, which compares the live turn's text to the
   * LAST assistant message. That comparison only holds for a turn that wrote
   * one uninterrupted run — and a tool call closes the run, so any turn that
   * called a tool joined "run1run2run3" and compared it against "run3", never
   * matched, and kept the overlay alive on top of a transcript that already had
   * all of it. Every line of the answer then rendered twice.
   *
   * Keyed on the trimmed text for the same reason `seenThinking` is: the live
   * run and the persisted one are the same string from the same stream, with
   * only trailing-whitespace differences between them.
   */
  readonly seenAssistantText: Set<string>;
  /**
   * Recap text and compaction count the transcript already holds.
   *
   * Tools dedupe by call id; these had no equivalent, so once the transcript
   * caught up while the live overlay was still in place BOTH were emitted —
   * which is why a settled turn showed "Recap" twice and "Context compacted"
   * twice in a row.
   */
  readonly seenRecaps: Set<string>;
  seenCompactions: number;
  /** Hands out the stamp that keeps emit order; see EmitOrder. */
  readonly order: EmitOrder;
  /** The turn the transcript's last prompt opened — see foldLiveTurn's turnId. */
  lastTurnId: string | null;
  /**
   * The latest checklist the transcript holds, and when it was written.
   *
   * Current state rather than history: every `todo` write replaces the whole
   * list, so replaying N writes as N activities would render N stale
   * checklists. Only the last one is emitted, and a live turn's list overrides
   * it — exactly what the CLI does (`latestTodos` seeds one pinned panel).
   */
  todos?: { items: readonly LoopTodo[]; ts: number };
}

/**
 * Tool output as the terminal treats it: text, not a JSON dump.
 *
 * MEASURED against a live transcript: a persisted result is the AI SDK's
 * `{type, value}` envelope — `{"type":"text","value":"3\n"}` — so stringifying
 * it renders that literal JSON where the file lines, the unified diff or the
 * command's stdout should be. The unwrapping mirrors `stringifyResult` in
 * packages/cli/src/interactive/components/chat-history.ts, which is how the
 * terminal has always read these.
 */
function toolOutputText(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  const record = output as Record<string, unknown>;

  if (typeof record.type === "string" && "value" in record) {
    const value = record.value;
    if (record.type === "text" || record.type === "error-text") {
      return typeof value === "string" ? value : String(value ?? "");
    }
    if (record.type === "json" || record.type === "error-json") {
      return detailOf(value);
    }
    if (record.type === "content" && Array.isArray(value)) {
      return value
        .map((part) => ((part as { type?: string })?.type === "text" ? (part as { text?: string }).text : ""))
        .filter(Boolean)
        .join("\n");
    }
  }

  // The live stream carries the tool's own `{content: [{type,text}], isError}`
  // instead — the shape the TUI's ToolResultLike reads.
  const content = Array.isArray(record.content) ? record.content : null;
  if (content) {
    const text = content
      .filter(
        (part): part is { type: string; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trimEnd();
    if (text !== "") return text;
  }
  return detailOf(output);
}

/**
 * Whether a tool result is a failure — what turns the row's diamond red.
 *
 * A persisted result says so through its envelope type (`error-text` /
 * `error-json`), which is exactly the test the terminal's replay makes; the
 * live shape carries an `isError` flag instead.
 */
function isErrorResult(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const record = output as { type?: unknown; isError?: unknown };
  return (
    record.type === "error-text" || record.type === "error-json" || record.isError === true
  );
}

function argsOf(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * The structured tool state a loop-shaped row is drawn from.
 *
 * The generic work log flattens a call into a heading and one `detail` string,
 * which is enough for a row that says "Tool - some text" and nothing like
 * enough for loop's grammar: a `read` row needs its `offset` to print
 * `:120-180` and to number its output lines, an `edit` needs its output kept
 * as a diff, a `task` needs its agent and live status. So the call goes into
 * the payload whole, under one key the renderer looks for.
 */
export interface LoopToolPayload {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly output?: string;
  readonly isError: boolean;
  /** The call has not returned yet. */
  readonly isPartial: boolean;
  /** The turn ended while it was still running. */
  readonly interrupted?: boolean;
  /** Live file content while write/edit/plan stream their input. */
  readonly streamingContent?: string;
  /** Subagent identity and live state, for `task`. */
  readonly agent?: string;
  readonly statusText?: string;
  readonly stats?: { steps?: number; durationMs?: number; usd?: number };
  /** Epoch ms the call began, for a still-running row's own elapsed clock.
   * `stats.durationMs` only exists once it has ended. */
  readonly startedAt?: number;
  /** What the subagent did, in order — the nested log inside a task row. */
  readonly activity?: readonly LiveSubagentStep[];
  /** Steps the retention cap dropped off the front of `activity`. */
  readonly droppedActivity?: number;
}

/** One reasoning block, as the thinking row draws it. */
export interface LoopThinkingPayload {
  readonly text: string;
  /** Absent on a replayed session — loop's transcript does not record it. */
  readonly durationMs?: number;
  readonly streaming: boolean;
}

/**
 * A compaction, as the transcript shows it.
 *
 * It is not a message and not a tool call — it is a statement about the
 * conversation: everything before the cut has been replaced, in the model's
 * context, by a summary. Rendering it is the difference between "the agent
 * forgot what we were doing" and "the context was compacted here".
 */
export interface LoopCompactPayload {
  /** loop's own word: `auto` (the threshold) or `manual` (/compact). Absent on
   * a replayed one — the transcript does not record which trigger it was, and
   * guessing would put a wrong word on the row. */
  readonly reason?: string;
  /** Still summarizing — this call takes tens of seconds. */
  readonly running: boolean;
  /** Absent while running, and when it was aborted. */
  readonly summary?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly aborted?: boolean;
  readonly error?: string;
}

/** Payload key for a tool call rendered the way loop's terminal renders it. */
export const LOOP_TOOL_PAYLOAD_KEY = "loopTool";
/** Payload key for a reasoning block. */
export const LOOP_THINKING_PAYLOAD_KEY = "loopThinking";
/** Payload key for a post-turn recap. */
export const LOOP_RECAP_PAYLOAD_KEY = "loopRecap";
/** Activity kind for a post-turn recap. */
export const RECAP_ACTIVITY_KIND = "loop.recap";
/** Payload key for a context compaction. */
export const LOOP_COMPACT_PAYLOAD_KEY = "loopCompact";
/** Activity kind for a context compaction. */
export const COMPACT_ACTIVITY_KIND = "loop.compact";
/**
 * Lines of a streaming input kept for the live preview.
 *
 * The row renders the last three (`LIVE_TAIL_LINES`); this is generous enough
 * that expanding one never shows an empty box, and bounded, which is the
 * point.
 */
const LIVE_PREVIEW_LINES = 24;

/**
 * The tail of a streaming tool input — never the whole thing.
 *
 * MEASURED, and this was the freeze: kimi streams a `write` as ~6700
 * `tool-input-delta` events over 55 seconds (~120/sec), and every one of them
 * re-ran the whole pipeline — fold the transcript, decode the thread through
 * its schema, push it across the atom graph, re-render the timeline — carrying
 * a copy of the ENTIRE file content that had arrived so far. Work proportional
 * to the file, twelve times a second, to draw three lines. The renderer's main
 * thread was blocked 78% of the wall clock with single freezes of 3.7s, so the
 * transcript did not paint until the storm stopped: exactly the "only renders
 * when it's done" report, and why the terminal (which appends to a buffer and
 * repaints a tail) never had it.
 *
 * Capping here rather than in the row keeps every stage downstream cheap.
 */
function livePreviewTail(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const lines = content.split("\n");
  return lines.length <= LIVE_PREVIEW_LINES
    ? content
    : lines.slice(lines.length - LIVE_PREVIEW_LINES).join("\n");
}

/** Payload key for a line a hook wrote. */
export const LOOP_HOOK_PAYLOAD_KEY = "loopHook";
/** Activity kind for a line a hook wrote. */
export const HOOK_ACTIVITY_KIND = "loop.hook";

/** One line of hook output, as the transcript shows it. */
export interface LoopHookPayload {
  readonly text: string;
}

function pushHookActivity(
  out: Accumulator,
  id: string,
  turnId: string | null,
  createdAt: string,
  text: string,
): void {
  out.activities.push({
    id,
    tone: "info",
    kind: HOOK_ACTIVITY_KIND,
    summary: "Hook",
    payload: { detail: text, [LOOP_HOOK_PAYLOAD_KEY]: { text } satisfies LoopHookPayload },
    turnId,
    createdAt,
  });
}

function pushCompactActivity(
  out: Accumulator,
  id: string,
  turnId: string | null,
  createdAt: string,
  compact: LoopCompactPayload,
): void {
  out.activities.push({
    id,
    tone: "info",
    kind: COMPACT_ACTIVITY_KIND,
    summary: compact.running ? "Compacting context" : "Context compacted",
    payload: {
      ...(compact.summary === undefined ? {} : { detail: compact.summary }),
      [LOOP_COMPACT_PAYLOAD_KEY]: compact,
    },
    turnId,
    createdAt,
  });
}

function pushToolActivity(
  out: Accumulator,
  options: {
    readonly id: string;
    readonly turnId: string | null;
    readonly createdAt: string;
    readonly name: string;
    readonly input: unknown;
    readonly output?: unknown;
    readonly error?: unknown;
    readonly toolCallId?: string;
    readonly isPartial?: boolean;
    readonly interrupted?: boolean;
    readonly streamingContent?: string;
    readonly agent?: string;
    readonly statusText?: string;
    readonly stats?: { steps?: number; durationMs?: number; usd?: number };
    readonly startedAt?: number;
    readonly activity?: readonly LiveSubagentStep[];
    readonly droppedActivity?: number;
  },
): void {
  const isError = options.error !== undefined;
  // A thrown tool error is an Error, and `JSON.stringify` makes that `{}` —
  // MEASURED: a `write` that failed rendered a red row whose whole detail was
  // two braces. formatError reads the shape loop's RPC server now sends.
  const output = isError ? formatError(options.error) : toolOutputText(options.output);
  const loopTool: LoopToolPayload = {
    name: options.name || "tool",
    args: argsOf(options.input),
    ...(output === undefined ? {} : { output }),
    isError,
    isPartial: options.isPartial ?? false,
    ...(options.interrupted ? { interrupted: true } : {}),
    ...(options.streamingContent ? { streamingContent: options.streamingContent } : {}),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.statusText === undefined ? {} : { statusText: options.statusText }),
    ...(options.stats === undefined ? {} : { stats: options.stats }),
    ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
    ...(options.activity === undefined || options.activity.length === 0
      ? {}
      : { activity: options.activity }),
    ...(options.droppedActivity ? { droppedActivity: options.droppedActivity } : {}),
  };
  out.activities.push({
    id: options.id,
    tone: isError ? "error" : "tool",
    kind: `tool.${options.name || "unknown"}`,
    summary: toolSummary(options.name, options.input),
    payload: {
      // `detail` stays for the generic consumers (search, the collapsed
      // preview); the structured copy is what the loop row actually draws.
      ...(output === undefined ? {} : { detail: output }),
      ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
      [LOOP_TOOL_PAYLOAD_KEY]: loopTool,
    },
    turnId: options.turnId,
    createdAt: options.createdAt,
  });
}

/**
 * A recap's text out of a persisted custom entry, or null for any other one.
 * Mirrors `isRecapPayload` in packages/core/src/agent/recap.ts.
 */
function recapTextOf(payload: unknown): string | null {
  const record = payload as { kind?: unknown; text?: unknown } | null;
  if (!record || typeof record !== "object") return null;
  if (record.kind !== "recap" || typeof record.text !== "string") return null;
  return record.text.trim() === "" ? null : record.text;
}

/** One checklist item as loop persists and broadcasts it (tools/todo.ts). */
export interface LoopTodo {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  readonly activeForm?: string;
}

/**
 * A checklist out of a persisted custom entry, or null for any other one.
 * Mirrors `isTodosPayload` in packages/core/src/tools/todo.ts.
 */
function todosOf(payload: unknown): readonly LoopTodo[] | null {
  const record = payload as { kind?: unknown; items?: unknown } | null;
  if (!record || typeof record !== "object") return null;
  if (record.kind !== "todos" || !Array.isArray(record.items)) return null;
  return record.items.filter(
    (item): item is LoopTodo => !!item && typeof (item as LoopTodo).content === "string",
  );
}

/**
 * loop's checklist as the plan sidebar's own shape.
 *
 * The app already renders exactly this — `deriveActivePlanState` reads
 * `turn.plan.updated` activities and `PlanSidebar` draws the steps with
 * per-status icons — so the checklist needs no new component, only this
 * mapping. Note `in_progress` → `inProgress`: loop uses the tool's snake_case
 * and the sidebar its own camelCase, and a mismatch renders silently as
 * "pending" for the one step actually being worked on.
 */
function pushTodosActivity(
  out: Accumulator,
  turnId: string | null,
  createdAt: string,
  items: readonly LoopTodo[],
): void {
  out.activities.push({
    id: "loop-todos",
    tone: "info",
    kind: "turn.plan.updated",
    summary: "Checklist",
    payload: {
      plan: items.map((item) => ({
        step:
          item.status === "in_progress" && item.activeForm?.trim()
            ? item.activeForm
            : item.content,
        status:
          item.status === "in_progress"
            ? "inProgress"
            : item.status === "completed" || item.status === "cancelled"
              ? item.status
              : "pending",
      })),
    },
    turnId,
    createdAt,
  });
}

function pushRecapActivity(
  out: Accumulator,
  id: string,
  turnId: string | null,
  createdAt: string,
  text: string,
): void {
  out.activities.push({
    id,
    tone: "info",
    kind: RECAP_ACTIVITY_KIND,
    summary: "Recap",
    payload: { detail: text, [LOOP_RECAP_PAYLOAD_KEY]: { text } },
    turnId,
    createdAt,
  });
}

/** Walk loop's persisted transcript into messages, activities and plans. */
function foldHistory(history: LoopHistory, sessionId: string): Accumulator {
  const out: Accumulator = {
    messages: [],
    activities: [],
    plans: [],
    seenToolCallIds: new Set(),
    seenThinking: new Set(),
    seenAssistantText: new Set(),
    seenRecaps: new Set(),
    seenCompactions: 0,
    order: new EmitOrder(),
    lastTurnId: null,
  };
  // Tool results arrive as their own `role: "tool"` entries, after the
  // assistant message that called them, so calls are indexed while walking and
  // their results merged in when they show up.
  const pendingTools = new Map<string, { index: number; name: string; input: unknown }>();
  /** The prompt everything since belongs to; see the user branch below. */
  let currentTurnId: string | null = null;

  for (const [position, entry] of history.entries.entries()) {
    const entryId = entry.id ?? `entry-${position}`;
    const createdAt = iso(entry.ts);

    // A recap persists as a custom entry so a resumed session re-renders it
    // (packages/core/src/agent/recap.ts). It is not a message and never
    // enters the model's context — it is a note under the reply.
    if (entry.type === "custom") {
      const payload = (entry as { payload?: unknown }).payload;
      const recap = recapTextOf(payload);
      if (recap) {
        pushRecapActivity(out, `${entryId}-recap`, currentTurnId, out.order.next(entry.ts), recap);
        out.seenRecaps.add(recap.trim());
      }
      // Kept, not emitted: a later write supersedes this one, and the winner
      // is decided once the whole transcript has been walked.
      const todos = todosOf(payload);
      if (todos) out.todos = { items: todos, ts: entry.ts };
      continue;
    }
    // MEASURED, and it is why a replayed session showed no subagents at all:
    // loop does NOT persist a `task` tool call inside the assistant message.
    // It writes a separate `subagent` ENTRY carrying the whole run — agent,
    // prompt, result, its ordered activity log, and its billed stats. So the
    // row is built from that rather than from a tool call that is not there;
    // the live path (`subagent-*` events) covers the same run while it runs.
    if (entry.type === "subagent") {
      const run = entry as unknown as {
        agent?: string;
        prompt?: string;
        result?: string;
        activity?: readonly { type?: string; text?: string; name?: string; summary?: string }[];
        steps?: number;
        durationMs?: number;
        usd?: number;
        toolCallId?: string;
      };
      const activity: LiveSubagentStep[] = [];
      for (const part of run.activity ?? []) {
        if (part.type === "tool" && typeof part.name === "string") {
          activity.push({
            kind: "tool",
            name: part.name,
            // Already formatted loop-side; re-deriving it from an input we do
            // not have would only lose information.
            ...(typeof part.summary === "string" ? { summary: part.summary } : {}),
          });
        } else if (part.type === "reasoning" && typeof part.text === "string") {
          activity.push({ kind: "thinking", text: part.text });
        } else if (part.type === "text" && typeof part.text === "string") {
          activity.push({ kind: "text", text: part.text });
        }
      }
      pushToolActivity(out, {
        id: `${entryId}-task`,
        turnId: currentTurnId,
        createdAt: out.order.next(entry.ts),
        name: "task",
        input: {
          ...(run.agent === undefined ? {} : { agent: run.agent }),
          ...(run.prompt === undefined ? {} : { prompt: run.prompt }),
        },
        ...(run.result === undefined ? {} : { output: run.result }),
        ...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
        ...(activity.length === 0 ? {} : { activity }),
        ...(run.steps === undefined && run.durationMs === undefined && run.usd === undefined
          ? {}
          : {
              stats: {
                ...(run.steps === undefined ? {} : { steps: run.steps }),
                ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
                ...(run.usd === undefined ? {} : { usd: run.usd }),
              },
            }),
      });
      // Retires the live overlay for the same run once the transcript has it,
      // or the finished task renders twice — once settled, once still
      // "running". The live events carry the task tool's own call id, which is
      // exactly what loop records here.
      if (run.toolCallId) out.seenToolCallIds.add(run.toolCallId);
      continue;
    }
    // A compaction is persisted as its own entry type, on the branch, so a
    // resumed session shows where the context was cut rather than appearing
    // to have skipped half the conversation.
    if (entry.type === "compact") {
      const compact = entry as unknown as {
        summary?: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
      out.seenCompactions += 1;
      pushCompactActivity(out, `${entryId}-compact`, currentTurnId, out.order.next(entry.ts), {
        running: false,
        ...(typeof compact.summary === "string" ? { summary: compact.summary } : {}),
        ...(typeof compact.tokensBefore === "number"
          ? { tokensBefore: compact.tokensBefore }
          : {}),
        ...(typeof compact.tokensAfter === "number" ? { tokensAfter: compact.tokensAfter } : {}),
      });
      continue;
    }
    if (entry.type !== "message") continue;

    if (entry.role === "user") {
      const { text, attachments } = splitUserAttachments(textOf(entry.content));
      if (text.trim() === "" && attachments.length === 0) continue;
      const userAt = out.order.next(entry.ts);
      // What the user asked starts a turn, and everything until the next
      // prompt belongs to it. Treating each assistant message as its own turn
      // (the transcript has no turn ids) chopped one reply into several and
      // printed a "Worked for 1ms" summary between every tool call.
      currentTurnId = entryId;
      out.lastTurnId = entryId;
      out.messages.push({
        // Reuse the id the client already rendered this message under, or it
        // appears twice: once optimistically, once from the transcript.
        id: recentUserMessageId(sessionId, text) ?? entryId,
        role: "user",
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        turnId: null,
        streaming: false,
        createdAt: userAt,
        updatedAt: userAt,
      });
      continue;
    }

    if (entry.role === "tool") {
      for (const part of partsOf(entry.content)) {
        const id = part.toolCallId;
        if (!id) continue;
        const pending = pendingTools.get(id);
        if (!pending) continue;
        const output = part.output ?? part.result;
        const text = toolOutputText(output);
        const activity = out.activities[pending.index] as {
          payload: Record<string, unknown>;
        };
        const loopTool = activity.payload[LOOP_TOOL_PAYLOAD_KEY] as LoopToolPayload | undefined;
        activity.payload = {
          ...activity.payload,
          ...(text === undefined ? {} : { detail: text }),
          // A persisted call is settled by definition: the result entry is
          // what proves it returned.
          ...(loopTool === undefined
            ? {}
            : {
                [LOOP_TOOL_PAYLOAD_KEY]: {
                  ...loopTool,
                  isPartial: false,
                  ...(text === undefined ? {} : { output: text }),
                  isError: isErrorResult(output),
                } satisfies LoopToolPayload,
              }),
        };
      }
      continue;
    }

    if (entry.role !== "assistant") continue;

    // Every assistant step since the last prompt is the same turn.
    const turnId = currentTurnId ?? entryId;

    // One ordered walk over the parts, the way the terminal builds its
    // transcript: text accumulates into the live message, and a tool call
    // CLOSES it and appends a sibling block (chat-history.ts addToolCall), so
    // whatever the model writes afterwards is a new message below the tool.
    // Concatenating all the text into one message instead forces the entire
    // reply above or below every call it made.
    let pendingText = "";
    let pendingTextAt: string | null = null;
    let textRun = 0;
    const flushText = () => {
      if (pendingText.trim() !== "") {
        textRun += 1;
        out.seenAssistantText.add(pendingText.trim());
        out.messages.push({
          id: textRun === 1 ? `${entryId}-assistant` : `${entryId}-assistant-${textRun}`,
          role: "assistant",
          text: pendingText,
          turnId,
          streaming: false,
          createdAt: pendingTextAt ?? out.order.next(entry.ts),
          updatedAt: pendingTextAt ?? out.order.current(),
        });
      }
      pendingText = "";
      pendingTextAt = null;
    };

    let ordinal = 0;
    for (const part of partsOf(entry.content)) {
      ordinal += 1;
      if (part.type === "text" && typeof part.text === "string") {
        if (pendingTextAt === null) pendingTextAt = out.order.next(entry.ts);
        pendingText += part.text;
        continue;
      }
      if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim() !== "") {
        flushText();
        out.activities.push({
          id: `${entryId}-reasoning-${ordinal}`,
          tone: "info",
          kind: THINKING_ACTIVITY_KIND,
          summary: "Thinking",
          payload: {
            detail: part.text,
            // No duration: loop's transcript records the text, not how long it
            // took. The row reads "Thought" rather than "Thought for 1.2s",
            // which is what the terminal does on a replayed session too.
            [LOOP_THINKING_PAYLOAD_KEY]: {
              text: part.text,
              streaming: false,
            } satisfies LoopThinkingPayload,
          },
          turnId,
          createdAt: out.order.next(entry.ts),
        });
        out.seenThinking.add(part.text.trim());
        continue;
      }
      if (part.type !== "tool-call") continue;
      flushText();

      const name = part.toolName ?? "unknown";
      const input = part.input ?? part.args;
      if (name === PLAN_TOOL) {
        // loop delivers a plan AS a tool call whose input is the document, so
        // it maps onto the plan card with no new protocol.
        const markdown = (input as { plan?: unknown } | undefined)?.plan;
        if (typeof markdown === "string" && markdown.trim() !== "") {
          const planAt = out.order.next(entry.ts);
          out.plans.push({
            id: part.toolCallId ?? `${entryId}-plan-${ordinal}`,
            turnId,
            planMarkdown: markdown,
            createdAt: planAt,
            updatedAt: planAt,
          });
          // Claim the id even though this took the plan branch instead of
          // becoming a tool row. The live overlay skips calls the transcript
          // already has, and it now emits plans too — without this the settled
          // plan and the live copy of the same call are two cards.
          if (part.toolCallId) out.seenToolCallIds.add(part.toolCallId);
          continue;
        }
      }
      const index = out.activities.length;
      pushToolActivity(out, {
        id: `${entryId}-tool-${ordinal}`,
        turnId,
        createdAt: out.order.next(entry.ts),
        name,
        input,
        ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }),
      });
      if (part.toolCallId) {
        pendingTools.set(part.toolCallId, { index, name, input });
        out.seenToolCallIds.add(part.toolCallId);
      }
    }
    flushText();
  }

  return out;
}

/**
 * Overlay the turn currently being streamed, if there is one.
 *
 * The overlay has to retire exactly once, and neither obvious rule is safe.
 * Dropping it the moment loop reports `finish` can blank the reply, because
 * the transcript is not guaranteed to be written by the time the rebuild runs
 * — and with no further events there would be no rebuild to restore it. Never
 * dropping it shows the reply twice, once live and once persisted.
 *
 * So retirement is driven by evidence rather than by timing: the overlay goes
 * away when the transcript already holds every text run it was carrying.
 *
 * Per RUN, not against the joined text. A tool call closes the current run, so
 * an agentic turn is several runs, and the transcript stores them as separate
 * assistant messages. Comparing the concatenation to the last of them never
 * matched, so the overlay outlived the transcript and the whole answer rendered
 * a second time below the first.
 */
function foldLiveTurn(
  out: Accumulator,
  sessionId: string,
  hostRunning = false,
): { running: boolean; turnId: string | null; todos?: readonly LoopTodo[] } {
  const live = readLiveTurn(sessionId);
  if (!live) return { running: false, turnId: null };

  const liveRuns = live.texts
    .map((run) => run.text.trim())
    .filter((text) => text !== "");
  if (!live.running && liveRuns.length > 0) {
    if (liveRuns.every((text) => out.seenAssistantText.has(text))) {
      clearLiveTurn(sessionId);
      // The revisions this was keyed on go with the turn.
      historyCache.delete(sessionId);
      return { running: false, turnId: null };
    }
  }

  /**
   * The turn this is, as the transcript names it.
   *
   * loop writes the prompt the moment a turn starts (and each finished step
   * after it), so mid-reply the transcript already holds the start of the very
   * turn this overlay is streaming. Under an id of its own the overlay was a
   * SECOND turn: the phone gave each half its own copy button, grouped them
   * apart, and only once the turn ended and the transcript took over did it
   * read as one reply. While loop says a turn is running, the last prompt is
   * that turn's.
   */
  const turnId = live.running && hostRunning && out.lastTurnId ? out.lastTurnId : `live-${live.startedAt}`;

  /**
   * The turn's blocks back in the order they were written.
   *
   * Each one recorded when it started, so sorting by that reconstructs the
   * stream — thinking, then the tool it led to, then the text after it. Walking
   * the three arrays one after another instead would print every thought, then
   * every tool, then the whole reply, no matter what actually happened.
   */
  const blocks: Array<{ seq: number; at: number; emit: (createdAt: string) => void }> = [];

  let thinkingOrdinal = 0;
  for (const block of live.thinking) {
    thinkingOrdinal += 1;
    if (block.text.trim() === "") continue;
    // Already in the transcript — rendering it again would double the block.
    if (out.seenThinking.has(block.text.trim())) continue;
    const streaming = block.endedAt === undefined && live.running;
    const id = `${turnId}-reasoning-${thinkingOrdinal}`;
    blocks.push({
      seq: block.seq,
      at: block.startedAt,
      emit: (createdAt) =>
        out.activities.push({
          id,
          tone: "info",
          kind: THINKING_ACTIVITY_KIND,
          summary: "Thinking",
          payload: {
            detail: block.text,
            [LOOP_THINKING_PAYLOAD_KEY]: {
              text: block.text,
              ...(block.endedAt === undefined
                ? {}
                : { durationMs: block.endedAt - block.startedAt }),
              streaming,
            } satisfies LoopThinkingPayload,
          },
          turnId,
          createdAt,
        }),
    });
  }

  let textOrdinal = 0;
  for (const run of live.texts) {
    textOrdinal += 1;
    if (run.text.trim() === "") continue;
    // Already persisted — the same rule tools and reasoning follow. loop
    // writes an assistant message per STEP, so a multi-step turn has its
    // earlier runs on disk while the live copy still carries all of them; a
    // closed run that history already holds would otherwise render twice
    // before the turn even ended.
    if (!run.open && out.seenAssistantText.has(run.text.trim())) continue;
    const id = textOrdinal === 1 ? `${turnId}-assistant` : `${turnId}-assistant-${textOrdinal}`;
    const streaming = run.open && live.running;
    blocks.push({
      seq: run.seq,
      at: run.startedAt,
      emit: (createdAt) =>
        out.messages.push({
          id,
          role: "assistant",
          text: run.text,
          turnId,
          streaming,
          createdAt,
          updatedAt: createdAt,
        }),
    });
  }

  let hookOrdinal = 0;
  for (const hook of live.hooks) {
    hookOrdinal += 1;
    const id = `${turnId}-hook-${hookOrdinal}`;
    blocks.push({
      seq: hook.seq,
      at: hook.startedAt,
      emit: (createdAt) => pushHookActivity(out, id, turnId, createdAt, hook.text),
    });
  }

  let compactOrdinal = 0;
  // Positional rather than by id: a compaction carries none, and the
  // transcript records them in the same order the live turn saw them — so the
  // first N live compactions are the N the transcript already holds.
  let compactionsToSkip = out.seenCompactions;
  for (const compaction of live.compactions) {
    if (compactionsToSkip > 0) {
      compactionsToSkip -= 1;
      continue;
    }
    compactOrdinal += 1;
    const id = `${turnId}-compact-${compactOrdinal}`;
    blocks.push({
      seq: compaction.seq,
      at: compaction.startedAt,
      emit: (createdAt) =>
        pushCompactActivity(out, id, turnId, createdAt, {
          reason: compaction.reason,
          running: compaction.running,
          ...(compaction.summary === undefined ? {} : { summary: compaction.summary }),
          ...(compaction.tokensBefore === undefined
            ? {}
            : { tokensBefore: compaction.tokensBefore }),
          ...(compaction.tokensAfter === undefined ? {} : { tokensAfter: compaction.tokensAfter }),
          ...(compaction.aborted ? { aborted: true } : {}),
          ...(compaction.error === undefined ? {} : { error: compaction.error }),
        }),
    });
  }

  let ordinal = 0;
  for (const tool of live.tools as readonly LiveToolCall[]) {
    ordinal += 1;
    // The transcript already has this call, settled. The live copy is the
    // same call mid-flight; showing both leaves a phantom row on "running".
    if (out.seenToolCallIds.has(tool.id)) continue;
    const isPartial = !tool.done && live.running;
    // The turn ended with the call still open — freeze it as interrupted
    // rather than leaving a spinner that never resolves.
    const interrupted = !tool.done && !live.running;
    const fields =
      tool.inputBuffer === undefined ? null : parsePartialInput(tool.name, tool.inputBuffer);
    // Before `tool-call` lands there are no parsed args, so the partial ones
    // stand in — that is how the path reaches the title while content streams.
    const input = tool.input ?? (fields?.path === undefined ? undefined : { path: fields.path });
    const streamingContent = livePreviewTail(fields?.content ?? fields?.plan);
    const id = `${turnId}-tool-${ordinal}`;

    if (tool.name === PLAN_TOOL) {
      // A plan is a document, and loop streams it: `tool-input-start` names the
      // tool, then the whole markdown arrives as `tool-input-delta` (MEASURED:
      // ~1600 deltas / 6.6 KB for one plan) long before the single `tool-call`.
      // Waiting for that call is what made the plan appear all at once, fully
      // written, at the end of the turn — the same document the settled
      // transcript renders as a card, but with nothing to watch while it was
      // being written. Emitting it as a plan the moment the first delta lands
      // means one card that fills in, rather than a tool row that is replaced
      // by a card when history refolds.
      const markdown =
        (tool.input as { plan?: unknown } | undefined)?.plan ?? fields?.plan;
      if (typeof markdown === "string" && markdown.trim() !== "") {
        blocks.push({
          seq: tool.seq,
          at: tool.startedAt,
          emit: (createdAt) => {
            out.plans.push({
              id: tool.id,
              turnId,
              planMarkdown: markdown,
              createdAt,
              updatedAt: createdAt,
            });
          },
        });
        continue;
      }
      // Nothing readable yet — the buffer is still inside the opening `{"plan":
      // "`. Fall through so the row exists and the turn does not look stalled.
    }
    blocks.push({
      seq: tool.seq,
      at: tool.startedAt,
      emit: (createdAt) =>
        pushToolActivity(out, {
          id,
          turnId,
          createdAt,
          name: tool.name,
          input,
          ...(tool.output === undefined ? {} : { output: tool.output }),
          ...(tool.error === undefined ? {} : { error: tool.error }),
          toolCallId: tool.id,
          isPartial,
          ...(interrupted ? { interrupted: true } : {}),
          ...(streamingContent ? { streamingContent } : {}),
          ...(tool.agent === undefined ? {} : { agent: tool.agent }),
          ...(tool.statusText === undefined ? {} : { statusText: tool.statusText }),
          startedAt: tool.startedAt,
          ...(tool.activity === undefined ? {} : { activity: tool.activity }),
          ...(tool.droppedActivity === undefined
            ? {}
            : { droppedActivity: tool.droppedActivity }),
          ...(tool.steps === undefined && tool.usd === undefined && tool.endedAt === undefined
            ? {}
            : {
                stats: {
                  ...(tool.steps === undefined ? {} : { steps: tool.steps }),
                  ...(tool.usd === undefined ? {} : { usd: tool.usd }),
                  ...(tool.endedAt === undefined
                    ? {}
                    : { durationMs: tool.endedAt - tool.startedAt }),
                },
              }),
        }),
    });
  }

  // By arrival, not by clock: several events routinely land in the same
  // millisecond, and sorting on time then falls back to which array was walked
  // first — every text run before every tool call, whatever really happened.
  //
  // A sorted copy, not `.toSorted()`: Hermes has no ES2023 change-by-copy
  // methods, so on the phone every mid-turn rebuild threw here and the thread
  // only moved when the turn ended and the overlay went away.
  for (const block of [...blocks].sort((a, b) => a.seq - b.seq)) {
    block.emit(out.order.next(block.at));
  }

  // Both arrive after everything above by definition: a recap is generated
  // once the turn is over, and an error ends it.
  // A question the agent is waiting on. The UI already renders
  // `user-input.requested` as an answer panel, so mapping onto it needs no new
  // component: `requestId` is loop's askId, which is what the answer carries
  // back. Emitted after the blocks above because the turn is paused ON it.
  if (live.ask !== undefined) {
    out.activities.push({
      id: `${turnId}-ask-${live.ask.askId}`,
      tone: "info",
      kind: "user-input.requested",
      summary: live.ask.questions[0]?.question ?? "The agent has a question",
      payload: {
        requestId: live.ask.askId,
        questions: live.ask.questions.map((question, index) => ({
          // The panel keys answers by question id; loop's questions are
          // positional, so the index IS the id.
          id: String(index),
          header: question.header,
          question: question.question,
          multiSelect: question.multiSelect === true,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
        })),
      },
      turnId,
      createdAt: out.order.next(Date.now()),
    });
  }

  // Skipped when the transcript already carries this recap — the two are the
  // same text, and rendering both is what put "Recap" on screen twice.
  if (live.recap !== undefined && !out.seenRecaps.has(live.recap.trim())) {
    pushRecapActivity(out, `${turnId}-recap`, turnId, out.order.next(Date.now()), live.recap);
  }

  if (live.error !== undefined) {
    out.activities.push({
      id: `${turnId}-error`,
      tone: "error",
      kind: "turn.error",
      summary: "The turn failed",
      payload: { detail: live.error },
      turnId,
      createdAt: out.order.next(Date.now()),
    });
  }

  return {
    running: live.running,
    turnId,
    ...(live.todos === undefined ? {} : { todos: live.todos }),
  };
}

/**
 * A thread loop has never heard of.
 *
 * The composer opens a draft the moment you click New thread, with a
 * client-generated id, and loop is told nothing until the first turn — asking
 * it for that transcript gets "Unknown sessionId", which is correct of loop and
 * fatal here: the failure killed the thread stream and the composer rendered
 * as a broken thread instead of an empty one.
 *
 * A draft is simply a thread with no messages yet.
 */
const emptyThread = (threadId: string, intent: { cwd: string; provider: string; model: string }) => {
  const now = new Date().toISOString();
  return decodeThread({
    id: threadId,
    projectId: intent.cwd,
    title: "New thread",
    modelSelection: {
      instanceId: toInstanceId(intent.provider),
      model: intent.model || "unknown",
      // Echoed back because loop persists neither the thinking level nor the
      // agent — without them the composer resets its effort picker the moment
      // a draft becomes a thread. See turnOptionsFor in dispatch.ts.
      options: turnOptionsFor(loopSessionIdFor(threadId)),
    },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  });
};

/**
 * The last transcript read, per session, while a turn is in flight.
 *
 * `session.history` returns the WHOLE conversation — every message, every tool
 * result, every reasoning block — and the live-turn subscription asks for a
 * rebuild every 80ms. On a long thread that is megabytes marshalled across the
 * bridge and parsed twelve times a second, which is what made a streaming
 * reasoning block crawl: the cost was proportional to the conversation so far,
 * not to the tokens arriving.
 *
 * Nothing in the transcript can change while only deltas are landing, so this
 * keeps the last read and revalidates it against `historyRevision` — see
 * liveTurn.ts. Any event that could have written an entry invalidates it, so
 * the transcript is still re-read whenever it could actually differ.
 */
const historyCache = new Map<string, { revision: number; history: LoopHistory }>();

/** The last whole branch read per session — what a tail is appended to. */
const lastHistory = new Map<string, LoopHistory>();
/**
 * Entries re-read before the end of what is held. The newest few can still be
 * amended in place (a reply marked interrupted, a step's usage landing), so
 * the tail starts a little before the end and replaces that overlap.
 */
const TAIL_OVERLAP = 4;

/** Tests only. */
export function forgetHistoriesForTests(): void {
  lastHistory.clear();
}

/**
 * `session.history`, but only what is new: the client says which entry it
 * already has and loop sends the branch after it (`afterEntryId`). A long
 * session is hundreds of KB, and re-reading it whole at every tool step is
 * what made a phone on Wi-Fi fall behind a turn until it ended. A host that
 * predates the parameter — or a branch that moved — answers with the whole
 * branch, which simply replaces what was held.
 */
export async function readHistory(host: LoopHost, sessionId: string): Promise<LoopHistory> {
  const held = lastHistory.get(sessionId);
  const anchorIndex = held ? held.entries.length - 1 - TAIL_OVERLAP : -1;
  const anchor = anchorIndex >= 0 ? held!.entries[anchorIndex]?.id : undefined;
  const answer = await host.call<LoopHistory>("session.history", {
    sessionId,
    ...(anchor ? { afterEntryId: anchor } : {}),
  });
  const whole: LoopHistory =
    held && anchor && answer.tail?.afterEntryId === anchor
      ? { ...answer, entries: [...held.entries.slice(0, anchorIndex + 1), ...answer.entries] }
      : answer;
  const { tail: _tail, ...withoutTail } = whole;
  lastHistory.set(sessionId, withoutTail);
  return withoutTail;
}

export const buildThread = Effect.fnUntraced(function* (
  loopSessionId: string,
  host: LoopHost = defaultLoopHost,
) {
  const intent = draftIntent(loopSessionId);
  if (intent) return yield* emptyThread(loopSessionId, intent);

  const turn = readLiveTurn(loopSessionId);
  const cached = historyCache.get(loopSessionId);
  // Read BEFORE the fetch: the turn is a live object, and an event landing
  // while `session.history` is in flight must invalidate the answer it gives.
  const revision = turn?.historyRevision;
  /**
   * A running turn that has gone silent — see `liveTurnIsQuiet`.
   *
   * The cache is keyed on the turn's own revision, so a turn whose end event
   * was lost freezes the revision AND the cached `running: true` with it: the
   * one fact that could unstick the view was the one the cache kept serving.
   */
  const quiet = turn !== undefined && turn.running && liveTurnIsQuiet(turn);
  // Only while the turn is running: once it ends loop writes the whole thing
  // down, and that final read is the one that must not be served from cache.
  const reusable =
    turn?.running === true && !quiet && cached !== undefined && cached.revision === revision;

  const history = reusable
    ? cached.history
    : yield* Effect.promise(() => readHistory(host, loopSessionId));
  if (!reusable) {
    if (revision === undefined) historyCache.delete(loopSessionId);
    else historyCache.set(loopSessionId, { revision, history });
  }

  /**
   * loop is the authority on whether a turn is running; the overlay is not.
   *
   * `live.running` closes only on `finish`/`error`, so any turn whose end never
   * reached this client — a dropped event, a resync that outran the ring, a
   * reload landing mid-turn — kept the composer on Stop and the timeline on
   * "Working for 12m" until the app was restarted. `history.running` is read
   * straight off loop's active-session table and knows better, and after six
   * silent seconds it is no longer racing anything this client just sent.
   *
   * Ends the turn BEFORE the fold, so the overlay retires in the same snapshot
   * rather than one rebuild later.
   */
  if (quiet) {
    if (history.running === false) endLiveTurn(loopSessionId);
    else confirmLiveTurnRunning(loopSessionId);
  }

  const out = foldHistory(history, loopSessionId);
  const live = foldLiveTurn(out, loopSessionId, history.running === true);
  const running = history.running || live.running;

  // The checklist, emitted once and last.
  //
  // A live turn's list wins outright: it is the same list further along, and
  // the transcript only gains its copy when the turn ends. Emitting both would
  // put two `turn.plan.updated` activities in play, and the sidebar takes the
  // last by order — which is the stale one whenever history sorts after the
  // overlay. Stamped `order.current()` so it never sorts before the work it
  // describes.
  const todos = live.todos ?? out.todos?.items;
  if (todos && todos.length > 0) {
    pushTodosActivity(out, live.turnId, out.order.current(), todos);
  }

  const firstUser = out.messages.find(
    (message) => (message as { role: string }).role === "user",
  ) as { text: string } | undefined;
  const title = history.name?.trim() || firstUser?.text.replace(/\s+/g, " ").slice(0, 80) || "Untitled";
  const updatedAt = iso(
    history.entries.length > 0 ? history.entries[history.entries.length - 1]!.ts : history.info.createdAt,
  );

  /**
   * The id the CLIENT knows this thread by, which is not always loop's.
   *
   * A thread the composer created lives at `/primary/<client-uuid>` while loop
   * names its session a ULID, and `buildShellSnapshot` already reports it under
   * the client id (`clientThreadIdFor`). Reporting loop's id here made the
   * detail disagree with the shell for exactly those threads, and the damage
   * was much wider than a cosmetic mismatch:
   *
   * - `mergeEnvironmentThread` bails on `detail.id !== shell.id`, so the shell's
   *   title/session/latestTurn were silently dropped.
   * - ChatView derives `activeThreadRef` from `activeThread.id` but reads
   *   `terminalUiState` from `routeThreadRef`. With the two ids different, the
   *   terminal toggle WROTE `terminalOpen: true` under loop's id and READ it
   *   back under the route's — so the drawer never mounted, the button looked
   *   dead, and every press spawned another PTY nobody could see.
   */
  const clientThreadId = clientThreadIdFor(loopSessionId);

  return yield* decodeThread({
    id: clientThreadId,
    projectId: history.info.cwd,
    title,
    modelSelection: {
      instanceId: toInstanceId(history.provider || history.info.provider),
      model: history.model || history.info.model || "unknown",
      options: turnOptionsFor(loopSessionId),
    },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn:
      live.turnId === null
        ? null
        : {
            turnId: live.turnId,
            state: running ? "running" : "completed",
            requestedAt: updatedAt,
            startedAt: updatedAt,
            completedAt: running ? null : updatedAt,
            assistantMessageId: null,
          },
    createdAt: iso(history.info.createdAt),
    updatedAt,
    archivedAt: null,
    deletedAt: null,
    messages: out.messages,
    proposedPlans: out.plans,
    activities: out.activities,
    checkpoints: [],
    session: {
      threadId: clientThreadId,
      status: running ? "running" : "idle",
      providerName: history.provider || history.info.provider || null,
      providerInstanceId: toInstanceId(history.provider || history.info.provider),
      runtimeMode: "full-access",
      activeTurnId: running ? live.turnId : null,
      lastError: null,
      updatedAt,
    },
  });
});

/** How long to gather live-turn changes before rebuilding the thread. */
const REBUILD_COALESCE_MS = 80;

/**
 * The same, for a window in which only deltas landed.
 *
 * A tool starting, returning or failing must reach the screen promptly — 80ms
 * is the budget for anything that changes what the transcript IS. Text,
 * reasoning and tool-input deltas only change how much of a block has been
 * written, and MEASURED they arrive at ~120/sec while a `write` streams; at the
 * structural cadence that is twelve full rebuilds a second, which is what
 * pinned the renderer. Three or four repaints a second is well past what reads
 * as live text, and it leaves the main thread free to actually paint them.
 */
const DELTA_COALESCE_MS = 250;

/**
 * How often a silent-but-running turn is checked against loop's own state.
 *
 * Only a turn that is BOTH running and quiet reaches the check, so on a settled
 * thread this timer wakes up, reads one map and goes back to sleep.
 */
const LIVENESS_CHECK_MS = 3_000;

const authFailure = (message: string) =>
  new EnvironmentAuthorizationError({ message, requiredScope: AuthOrchestrationReadScope });

/**
 * Subscribe loop's event stream to this session.
 *
 * loop only broadcasts a turn to clients that have attached, so without this
 * a thread would render its transcript and then sit still while the agent
 * worked. `session.open` revives the session without subscribing; `attach`
 * is the subscription, and is a separate call precisely so history can be
 * rendered first and no event can slip in between and apply twice.
 */
const attach = (loopSessionId: string, host: LoopHost) =>
  Effect.promise(async () => {
    // No `session.open` first: attach revives the session itself
    // (`ensureCtx`), and the extra round trip was pure latency on every open —
    // on a phone over Tailscale, a visible part of "Loading messages".
    // `afterSeq` is the difference between watching a turn and missing it.
    //
    // loop persists a turn only once it ends and broadcasts only to clients
    // that have attached, so a session already running when this thread is
    // opened — started in the terminal, in another window, or before the app
    // was restarted — has nothing on disk and nothing in flight to catch. It
    // rendered as a settled conversation sitting perfectly still while the
    // agent worked. Attaching from the last seq this client applied (0 when it
    // has applied none) replays loop's event ring, which rebuilds the turn so
    // far; `running` from the response is what marks it as still going, since
    // a `finish` left in the ring by an EARLIER turn would otherwise say the
    // opposite.
    const attached = await host.call<{ running?: boolean; resync?: boolean; seq?: number }>("session.attach", {
      sessionId: loopSessionId,
      afterSeq: lastEventSeq(loopSessionId),
    }).catch(() => null);
    if (attached === null) return;
    if (typeof attached.seq === "number") syncEventSeq(loopSessionId, attached.seq);
    // The gap outran the ring, so nothing was replayed and what this client
    // holds is not contiguous. History is the honest fallback, and the next
    // attach starts over rather than resuming from a seq that means nothing.
    if (attached.resync === true) {
      forgetEventSeq(loopSessionId);
      clearLiveTurn(loopSessionId);
    }
    if (attached.running === true) adoptRunningTurn(loopSessionId, host);
  });

const snapshotItem = (thread: unknown): OrchestrationThreadStreamItem =>
  ({ kind: "snapshot", snapshot: { snapshotSequence: 0, thread } }) as OrchestrationThreadStreamItem;

/**
 * The thread as a stream: the transcript, the completion marker the client
 * waits on, then a fresh snapshot each time the in-flight turn moves.
 */
export function threadStream(
  threadId: string,
  host: LoopHost = defaultLoopHost,
): Stream.Stream<OrchestrationThreadStreamItem, EnvironmentAuthorizationError> {
  /**
   * Resolved on every use, never captured.
   *
   * A draft subscribes before loop has a session for it, and the id only
   * appears when the first turn creates one. Capturing it at subscribe time
   * left the stream watching a session that would never exist: loop ran the
   * turn and finished it, and the UI sat on "Working for 1m 40s" because it
   * was listening for the wrong id.
   */
  const currentSessionId = () => loopSessionIdFor(threadId);
  /**
   * The session this stream's socket is subscribed to, shared by the first
   * snapshot and the updates after it.
   *
   * Tracked separately, the updates did not know the first snapshot had
   * attached and attached again on their first rebuild — a wasted round trip
   * on every open, and a replay of events the socket had already delivered.
   */
  let attached: string | null = null;

  const initial = Effect.gen(function* () {
    const sessionId = currentSessionId();
    // A draft has nothing to attach to yet; the first rebuild does it.
    if (draftIntent(sessionId) === undefined) {
      yield* attach(sessionId, host);
      attached = sessionId;
    }
    const thread = yield* buildThread(sessionId, host);
    return [snapshotItem(thread), { kind: "synchronized" as const }];
  }).pipe(Effect.mapError(() => authFailure(`loop could not open thread ${threadId}`)));

  const updates = Stream.callback<OrchestrationThreadStreamItem>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        /**
         * One rebuild at a time.
         *
         * The coalescing window only gated SCHEDULING, so a rebuild slower than
         * 80ms — which is what a long transcript is — had the next one queued
         * before it finished, and the backlog grew for as long as the model
         * kept streaming. Holding the window open until the rebuild lands makes
         * the interval a floor rather than a fixed rate, so a thread that is
         * expensive to rebuild simply updates less often instead of falling
         * further behind.
         */
        let building = false;
        let pending = false;
        /** Whether anything structural has landed since the last rebuild. */
        let sawStructural = true;

        const rebuild = () => {
          building = true;
          sawStructural = false;
          const sessionId = currentSessionId();
          const ready =
            attached === sessionId
              ? Promise.resolve()
              : Effect.runPromise(attach(sessionId, host)).then(() => {
                  attached = sessionId;
                });
          void ready
            .then(() => Effect.runPromise(buildThread(sessionId, host)))
            .then((thread) => Queue.offerUnsafe(queue, snapshotItem(thread)))
            .catch(() => undefined)
            .finally(() => {
              building = false;
              // Something changed while this was in flight, so the snapshot
              // just sent is already stale — go again.
              if (pending) {
                pending = false;
                schedule();
              }
            });
        };

        const schedule = () => {
          if (timer !== null) return;
          // Everything waiting is a delta: worth showing, not worth a full
          // rebuild twelve times a second.
          const deltaOnly = !sawStructural;
          timer = setTimeout(
            () => {
              timer = null;
              if (building) {
                pending = true;
                return;
              }
              rebuild();
            },
            deltaOnly ? DELTA_COALESCE_MS : REBUILD_COALESCE_MS,
          );
        };

        /**
         * The only thing that re-examines a turn which has stopped changing.
         *
         * Every rebuild above is triggered by a live-turn event, which makes
         * the whole view blind to the one failure that matters: a turn whose
         * end never arrives emits nothing more, so nothing asks again and the
         * thread sits on "Working" forever. `buildThread` already reconciles
         * against loop's own `running` flag — this is what gives it the chance
         * to, and it only fires while a turn is both running and silent, so a
         * settled thread costs nothing.
         */
        const watchdog = setInterval(() => {
          const live = readLiveTurn(currentSessionId());
          if (!live?.running || !liveTurnIsQuiet(live)) return;
          schedule();
        }, LIVENESS_CHECK_MS);

        const unsubscribe = onLiveTurnChange((changed, structural) => {
          if (changed !== currentSessionId()) return;
          if (structural) sawStructural = true;
          if (building) {
            pending = true;
            return;
          }
          schedule();
        });

        /**
         * A reconnected socket is not a subscribed one.
         *
         * loop tracks subscribers per TRANSPORT, so the attach this stream did
         * belongs to the socket that has just gone away. Nothing re-attached
         * the new one, and since `attached` still named this session the
         * rebuild path never tried again — so after any drop the thread went
         * permanently silent: turns ran to completion with the transcript
         * frozen, and only a reload brought it back. Forgetting the attach and
         * asking for a rebuild re-subscribes, and `afterSeq` replays whatever
         * was missed while the socket was down.
         */
        const unwatchConnection = host.onConnectionChange((state) => {
          if (state !== "open") return;
          attached = null;
          schedule();
        });

        // The shell lists a page of sessions, and this one may be older than
        // it (opened from search, or a link). The view is merged with its
        // shell row, so it is kept in the shell for as long as it is open.
        const unpin = pinSession(host.id, currentSessionId());

        return () => {
          if (timer !== null) clearTimeout(timer);
          clearInterval(watchdog);
          pending = false;
          unsubscribe();
          unwatchConnection();
          unpin();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );

  return Stream.fromEffect(initial).pipe(Stream.flattenIterable, Stream.concat(updates));
}
