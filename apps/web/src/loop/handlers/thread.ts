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
  onLiveTurnChange,
  readLiveTurn,
  type LiveSubagentStep,
} from "./liveTurn.ts";
import { parsePartialInput } from "./streamingInput.ts";
import { defaultLoopHost, type LoopHost } from "../transport.ts";
import { isToolPart, type TeamPart, type Transcript } from "@loop/transcript";
import { readTranscript, snapshotOf, watchTranscript, type TranscriptView } from "../transcript/store.ts";

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

/** Payload key for something the thread team wrote into this thread. */
export const LOOP_TEAM_PAYLOAD_KEY = "loopTeam";
/** Activity kind for a team card (a brief, a message, a report). */
export const TEAM_ACTIVITY_KIND = "loop.team";

/** loop's data-team part as a card payload, its senders routable by this client's ids. */
function teamPayloadOf(data: TeamPart["data"]): Record<string, unknown> {
  const peer = (p: { id: string; title: string }) => ({ id: p.id, threadId: clientThreadIdFor(p.id), title: p.title });
  return {
    kind: data.kind,
    teamId: data.teamId,
    ...(data.from ? { from: peer(data.from) } : {}),
    ...(data.title ? { title: data.title } : {}),
    ...(data.text ? { text: data.text } : {}),
    ...(data.mail ? { mail: data.mail.map((m) => ({ ...m, from: peer(m.from) })) } : {}),
    ...(data.midTurn ? { midTurn: true } : {}),
  };
}

function pushTeamActivity(out: Accumulator, id: string, turnId: string | null, createdAt: string, data: TeamPart["data"]): void {
  const first = data.mail?.[0];
  out.activities.push({
    id,
    tone: "info",
    kind: TEAM_ACTIVITY_KIND,
    summary:
      data.kind === "spawn"
        ? `Brief from ${data.from?.title ?? "the lead"}`
        : first?.kind === "report"
          ? `Report from ${first.from.title}`
          : `Message from ${first?.from.title ?? "a teammate"}`,
    payload: {
      detail: data.kind === "spawn" ? (data.text ?? "") : (data.mail ?? []).map((m) => m.text).join("\n\n"),
      [LOOP_TEAM_PAYLOAD_KEY]: teamPayloadOf(data),
    },
    turnId,
    createdAt,
  });
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
/**
 * loop's transcript (packages/core/src/transcript) as the thread's rows.
 *
 * One walk over the parts, in the order they were written — the host already
 * merged saved history with the live stream, with the terminal's rules, so
 * nothing here reconciles, deduplicates or reorders anything. Each row is
 * stamped from a strictly increasing counter, so any view that sorts by
 * `createdAt` gets exactly this order back.
 *
 * The rows are the same objects the screens already draw (tool rows, thinking
 * blocks, plan cards, compaction and recap rows); only where their order comes
 * from changed.
 */
function foldTranscript(transcript: Transcript, sessionId: string): Accumulator {
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
  let turnId: string | null = null;

  for (const message of transcript.messages) {
    const at = message.metadata.createdAt;
    if (message.role === "user") {
      // A turn the thread team opened: a card, never a user bubble.
      const team = message.parts.find((part): part is TeamPart => part.type === "data-team");
      if (team) {
        turnId = message.id;
        out.lastTurnId = message.id;
        // Outside the turn it opens, like the prompt it stands in for: a
        // finished turn folds its work away, and the brief is not work.
        pushTeamActivity(out, `${message.id}-team`, null, out.order.next(at), team.data);
        continue;
      }
      const raw = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
      const { text, attachments } = splitUserAttachments(raw);
      if (text.trim() === "" && attachments.length === 0) continue;
      turnId = message.id;
      out.lastTurnId = message.id;
      const userAt = out.order.next(at);
      out.messages.push({
        // The id the client already drew this message under, or it shows twice.
        id: recentUserMessageId(sessionId, text) ?? message.id,
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

    const rowTurn = message.role === "assistant" ? (turnId ?? message.id) : null;
    for (const [index, part] of message.parts.entries()) {
      const id = `${message.id}-${index}`;
      const stamp = out.order.next(at);
      if (part.type === "text") {
        if (part.text.trim() === "") continue;
        out.messages.push({
          id,
          role: "assistant",
          text: part.text,
          turnId: rowTurn,
          streaming: part.state === "streaming",
          createdAt: stamp,
          updatedAt: stamp,
        });
      } else if (part.type === "reasoning") {
        if (part.text.trim() === "" && part.state !== "streaming") continue;
        out.activities.push({
          id,
          tone: "info",
          kind: THINKING_ACTIVITY_KIND,
          summary: "Thinking",
          payload: {
            detail: part.text,
            [LOOP_THINKING_PAYLOAD_KEY]: {
              text: part.text,
              ...(part.durationMs === undefined ? {} : { durationMs: part.durationMs }),
              streaming: part.state === "streaming",
            } satisfies LoopThinkingPayload,
          },
          turnId: rowTurn,
          createdAt: stamp,
        });
      } else if (isToolPart(part)) {
        const fields = part.inputText === undefined ? null : parsePartialInput(part.toolName, part.inputText);
        if (part.toolName === PLAN_TOOL) {
          const markdown = (part.input as { plan?: unknown } | undefined)?.plan ?? fields?.plan;
          if (typeof markdown === "string" && markdown.trim() !== "") {
            out.plans.push({ id: part.toolCallId, turnId: rowTurn, planMarkdown: markdown, createdAt: stamp, updatedAt: stamp });
            continue;
          }
        }
        const run = part.subagent;
        const open = part.state === "input-streaming" || part.state === "input-available";
        const streamingContent = livePreviewTail(fields?.content ?? fields?.plan);
        pushToolActivity(out, {
          id,
          turnId: rowTurn,
          createdAt: stamp,
          name: part.toolName,
          // Before the call lands there are no parsed args; the partial ones
          // stand in, which is how a streaming `write` shows its path.
          input: part.input ?? (fields?.path === undefined ? undefined : { path: fields.path }),
          ...(part.state === "output-available" ? { output: part.output } : {}),
          ...(part.state === "output-error" && part.errorText !== "Interrupted" ? { error: part.errorText } : {}),
          toolCallId: part.toolCallId,
          isPartial: open && transcript.running,
          ...(part.errorText === "Interrupted" ? { interrupted: true } : {}),
          ...(streamingContent ? { streamingContent } : {}),
          ...(run ? { agent: run.agent } : {}),
          ...(run?.current === undefined || run.finished ? {} : { statusText: run.current }),
          ...(run?.dropped ? { droppedActivity: run.dropped } : {}),
          ...(run && run.steps.length > 0
            ? {
                activity: run.steps.map((step) =>
                  step.type === "tool"
                    ? typeof step.input === "string"
                      ? { kind: "tool" as const, name: step.name, summary: step.input }
                      : { kind: "tool" as const, name: step.name, input: step.input }
                    : step.type === "reasoning"
                      ? { kind: "thinking" as const, text: step.text }
                      : { kind: "text" as const, text: step.text },
                ),
              }
            : {}),
          ...(run && (run.stepCount !== undefined || run.usd !== undefined || run.durationMs !== undefined)
            ? {
                stats: {
                  ...(run.stepCount === undefined ? {} : { steps: run.stepCount }),
                  ...(run.usd === undefined ? {} : { usd: run.usd }),
                  ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
                },
              }
            : {}),
        });
      } else if (part.type === "data-compaction") {
        pushCompactActivity(out, id, rowTurn, stamp, {
          running: part.data.running,
          ...(part.data.reason === undefined ? {} : { reason: part.data.reason }),
          ...(part.data.summary === undefined ? {} : { summary: part.data.summary }),
          ...(part.data.tokensBefore === undefined ? {} : { tokensBefore: part.data.tokensBefore }),
          ...(part.data.tokensAfter === undefined ? {} : { tokensAfter: part.data.tokensAfter }),
          ...(part.data.aborted ? { aborted: true } : {}),
          ...(part.data.error === undefined ? {} : { error: part.data.error }),
        });
      } else if (part.type === "data-recap") {
        pushRecapActivity(out, id, rowTurn, stamp, part.data.text);
      } else if (part.type === "data-hook") {
        pushHookActivity(out, id, rowTurn, stamp, part.data.text);
      } else if (part.type === "data-error") {
        out.activities.push({
          id,
          tone: "error",
          kind: "turn.error",
          summary: "The turn failed",
          payload: { detail: part.data.message },
          turnId: rowTurn,
          createdAt: stamp,
        });
      } else if (part.type === "data-branch-summary") {
        pushRecapActivity(out, id, null, stamp, part.data.summary);
      } else if (part.type === "data-team") {
        pushTeamActivity(out, id, rowTurn, stamp, part.data);
      }
    }
  }

  // A question the agent is waiting on: not part of any turn's events, so it
  // still comes from the live-turn tracker.
  const ask = readLiveTurn(sessionId)?.ask;
  if (ask !== undefined && transcript.running) {
    out.activities.push({
      id: `${turnId ?? sessionId}-ask-${ask.askId}`,
      tone: "info",
      kind: "user-input.requested",
      summary: ask.questions[0]?.question ?? "The agent has a question",
      payload: {
        requestId: ask.askId,
        questions: ask.questions.map((question, index) => ({
          id: String(index),
          header: question.header,
          question: question.question,
          multiSelect: question.multiSelect === true,
          options: question.options.map((option) => ({ label: option.label, description: option.description })),
        })),
      },
      turnId,
      createdAt: out.order.next(Date.now()),
    });
  }

  if (transcript.todos.length > 0) {
    out.todos = { items: transcript.todos as readonly LoopTodo[], ts: Date.now() };
  }
  return out;
}

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

export const buildThread = Effect.fnUntraced(function* (
  loopSessionId: string,
  host: LoopHost = defaultLoopHost,
  view?: TranscriptView,
) {
  const intent = draftIntent(loopSessionId);
  if (intent) return yield* emptyThread(loopSessionId, intent);

  // The host's transcript: saved history and the turn in flight, merged once,
  // there. A caller watching the session passes what it holds; otherwise this
  // asks for a snapshot.
  const { transcript, meta } =
    view?.ready === true ? view : yield* Effect.promise(() => snapshotOf(host, loopSessionId));
  const out = foldTranscript(transcript, loopSessionId);
  const running = transcript.running;

  // The checklist, emitted once and last, so the sidebar never reads a stale copy.
  if (out.todos && out.todos.items.length > 0) {
    pushTodosActivity(out, out.lastTurnId, out.order.current(), out.todos.items);
  }

  const info = meta.info ?? {};
  const provider = meta.provider || info.provider || "";
  const model = meta.model || info.model || "unknown";
  const firstUser = out.messages.find(
    (message) => (message as { role: string }).role === "user",
  ) as { text: string } | undefined;
  const title = meta.name?.trim() || firstUser?.text.replace(/\s+/g, " ").slice(0, 80) || "Untitled";
  const lastMessage = transcript.messages[transcript.messages.length - 1];
  const updatedAt = iso(lastMessage?.metadata.createdAt ?? info.createdAt ?? Date.now());
  // A turn running with no prompt in view (started where this client could not
  // see it) is still running: it goes by its reply's id.
  const turnId = running ? (out.lastTurnId ?? lastMessage?.id ?? null) : null;

  /**
   * The id the CLIENT knows this thread by, which is not always loop's: a
   * thread the composer created lives under its client uuid while loop names
   * the session a ULID, and the shell reports it under the client id
   * (`clientThreadIdFor`). Reporting loop's id here made the detail disagree
   * with the shell — the shell's title and status were dropped, and the
   * terminal toggle wrote and read its state under different ids.
   */
  const clientThreadId = clientThreadIdFor(loopSessionId);

  return yield* decodeThread({
    id: clientThreadId,
    projectId: info.cwd ?? "/",
    title,
    modelSelection: {
      instanceId: toInstanceId(provider),
      model,
      options: turnOptionsFor(loopSessionId),
    },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn:
      turnId === null
        ? null
        : {
            turnId,
            state: "running",
            requestedAt: updatedAt,
            startedAt: updatedAt,
            completedAt: null,
            assistantMessageId: null,
          },
    createdAt: iso(info.createdAt ?? Date.now()),
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
      providerName: provider || null,
      providerInstanceId: toInstanceId(provider),
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt,
    },
  });
});

/** How long to gather live-turn changes before rebuilding the thread. */
const REBUILD_COALESCE_MS = 80;

const authFailure = (message: string) =>
  new EnvironmentAuthorizationError({ message, requiredScope: AuthOrchestrationReadScope });

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
   * Resolved on every use, never captured: a draft has no loop session until
   * its first turn creates one, and a stream that captured the draft's id
   * watched a session that would never exist.
   */
  const currentSessionId = () => loopSessionIdFor(threadId);

  return Stream.callback<OrchestrationThreadStreamItem, EnvironmentAuthorizationError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let synchronized = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let watching: { sessionId: string; stop: () => void } | null = null;

        const emit = (sessionId: string) => {
          const view = draftIntent(sessionId) === undefined ? readTranscript(host, sessionId) : undefined;
          if (view !== undefined && !view.ready) return;
          void Effect.runPromise(buildThread(sessionId, host, view))
            .then((thread) => {
              Queue.offerUnsafe(queue, snapshotItem(thread));
              if (!synchronized) {
                synchronized = true;
                Queue.offerUnsafe(queue, { kind: "synchronized" } as OrchestrationThreadStreamItem);
              }
            })
            .catch(() => undefined);
        };

        /**
         * One rebuild per window. The transcript is held locally, so a rebuild
         * is a fold, not a fetch — but a reply streams ~100 deltas a second,
         * and redrawing the whole thread for each would still pin a phone.
         */
        const schedule = () => {
          if (timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            emit(currentSessionId());
          }, REBUILD_COALESCE_MS);
        };

        const follow = () => {
          const sessionId = currentSessionId();
          if (watching?.sessionId === sessionId) return;
          watching?.stop();
          watching = null;
          if (draftIntent(sessionId) !== undefined) {
            emit(sessionId);
            return;
          }
          watching = { sessionId, stop: watchTranscript(host, sessionId, schedule) };
          // Already held (another view of the same session): draw it now.
          if (readTranscript(host, sessionId).ready) emit(sessionId);
        };

        // A draft becomes a session when its first turn starts, and that is
        // news only the live-turn tracker hears first.
        const unsubscribe = onLiveTurnChange(() => follow());
        follow();

        // The shell lists a page of sessions; this one is kept in it while open.
        const unpin = pinSession(host.id, currentSessionId());

        return () => {
          if (timer !== null) clearTimeout(timer);
          watching?.stop();
          unsubscribe();
          unpin();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );
}
