/**
 * A transcript, without the app.
 *
 * Checking how a turn renders used to mean rebuilding the renderer, launching
 * Electron, driving it over CDP and racing the composer — minutes per attempt,
 * and flaky at that. Nothing about the pipeline actually needs a window: loop's
 * events fold into a thread, the thread derives work-log and timeline entries,
 * and those derive the rows the components draw. All of it is pure.
 *
 * So this drives exactly that path, in the same order `ChatView` does
 * (deriveWorkLogEntries → deriveTimelineEntries → deriveMessagesTimelineRows),
 * and hands back a flat description of the blocks in the order they render.
 * Feed it loop's own wire shapes — `session.history` entries and
 * `session.event` parts — and the assertion is the sequence itself.
 *
 * Test-only. Nothing in the app imports it, so it never reaches the bundle.
 */
import type { OrchestrationThreadActivity } from "@loop/contracts";
import * as Effect from "effect/Effect";

import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
} from "../../components/chat/MessagesTimeline.logic";
import { compactLabel } from "../../components/loop/LoopCompactRow";
import {
  loopCompactOf,
  loopHookOf,
  loopRecapOf,
  loopThinkingOf,
  loopToolOf,
} from "../../components/loop/loopEntry";
import {
  formatTaskStatus,
  formatToolArgs,
  readLineRangeText,
} from "../../components/loop/loopToolSummary";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import { applyEvent, applyEvents, fromEntries } from "@loop/transcript";

import { applyLoopEvent, clearLiveTurn } from "../handlers/liveTurn.ts";
import { buildThread } from "../handlers/thread.ts";

/** One `session.event` notification's part, as the RPC server broadcasts it. */
export interface LoopEventPart {
  readonly type: string;
  readonly data?: unknown;
}

export interface RenderedBlock {
  /** What kind of block this is, in the transcript's own terms. */
  readonly kind:
    | "user"
    | "assistant"
    | "thinking"
    | "tool"
    | "recap"
    | "compact"
    | "hook"
    | "plan"
    | "other";
  /** A one-line description: the row's own text for a tool, the text for a message. */
  readonly label: string;
  /** Tool rows only. */
  readonly tool?: {
    readonly name: string;
    readonly summary: string;
    readonly state: "running" | "success" | "error" | "interrupted";
    readonly output?: string;
    readonly streamingContent?: string;
    /** The status a `task` row shows on its right edge. */
    readonly status?: string;
    /** A subagent's nested log, one string per step. */
    readonly activity?: readonly string[];
  };
  /** Thinking rows only. */
  readonly thinking?: { readonly text: string; readonly streaming: boolean; readonly durationMs?: number };
}

export interface RenderedTranscript {
  readonly blocks: readonly RenderedBlock[];
  /** The thread's raw activities, for consumers that read them directly
      (pending approvals, pending user input). */
  readonly activities: readonly OrchestrationThreadActivity[];
  /** `kind` per block, the compact form most assertions want. */
  readonly shape: readonly string[];
  /** The raw rows, for assertions the summary does not cover. */
  readonly rows: readonly MessagesTimelineRow[];
}

const globals = globalThis as { window?: Window & typeof globalThis };

const DEFAULT_INFO = {
  cwd: "/w/project",
  provider: "kimi",
  model: "kimi/k3",
  createdAt: 1_700_000_000_000,
};

/**
 * Fold history + a live turn into the blocks the timeline renders.
 *
 * Built the way the host builds its transcript (packages/core/src/transcript):
 * the saved branch, then `events` applied in order — so a turn can be
 * described mid-flight (`running: true`) or after it settled.
 */
export async function renderTranscript(input: {
  readonly history?: readonly unknown[];
  readonly events?: readonly LoopEventPart[];
  readonly running?: boolean;
  readonly sessionId?: string;
  readonly info?: Partial<typeof DEFAULT_INFO>;
}): Promise<RenderedTranscript> {
  const sessionId = input.sessionId ?? `01HARNESS${Math.random().toString(36).slice(2, 8)}`;
  const info = { ...DEFAULT_INFO, ...input.info };
  const entries = input.history ?? [];

  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: (method) =>
      method === "session.history"
        ? Promise.resolve({
            sessionId,
            info,
            entries,
            seq: entries.length,
            running: input.running ?? false,
          })
        : Promise.resolve({}),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };

  try {
    const events = input.events ?? [];
    let transcript = fromEntries(entries as Parameters<typeof fromEntries>[0], {
      running: events.length === 0 && input.running === true,
    });
    transcript = applyEvents(transcript, events);
    // A pending question is not a turn event; the live-turn tracker holds it.
    for (const event of events) if (event.type === "ask") applyLoopEvent(sessionId, event);
    if (events.length > 0 && input.running === false) {
      transcript = applyEvent(transcript, { type: "finish", data: {} });
      transcript = applyEvent(transcript, { type: "session-running", data: { running: false } });
    }

    const thread = await Effect.runPromise(
      buildThread(sessionId, undefined, {
        transcript,
        ready: true,
        meta: { info, model: info.model, provider: info.provider },
      }),
    );

    // The same composition ChatView performs.
    const workEntries = deriveWorkLogEntries(thread.activities);
    const timelineEntries = deriveTimelineEntries(
      thread.messages,
      thread.proposedPlans,
      workEntries,
    );
    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      foldSettledTurns: false,
      groupWorkEntries: false,
      showWorkingRow: false,
      isWorking: input.running ?? false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    return {
      blocks: describeRows(rows, info.cwd),
      shape: shapeOf(rows, info.cwd),
      rows,
      activities: thread.activities,
    };
  } finally {
    clearLiveTurn(sessionId);
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  }
}

function toolState(tool: NonNullable<ReturnType<typeof loopToolOf>>): "running" | "success" | "error" | "interrupted" {
  if (tool.isError && !tool.isPartial) return "error";
  if (tool.isPartial) return "running";
  if (tool.interrupted) return "interrupted";
  return "success";
}

function describeRows(rows: readonly MessagesTimelineRow[], cwd: string): RenderedBlock[] {
  const blocks: RenderedBlock[] = [];
  for (const row of rows) {
    if (row.kind === "message") {
      blocks.push({
        kind: row.message.role === "user" ? "user" : "assistant",
        label: row.message.text,
      });
      continue;
    }
    if (row.kind === "proposed-plan") {
      blocks.push({ kind: "plan", label: row.proposedPlan.planMarkdown.split("\n")[0] ?? "" });
      continue;
    }
    if (row.kind !== "work") {
      blocks.push({ kind: "other", label: row.kind });
      continue;
    }
    for (const entry of row.groupedEntries) {
      const compact = loopCompactOf(entry);
      if (compact) {
        blocks.push({ kind: "compact", label: compactLabel(compact) });
        continue;
      }
      const recap = loopRecapOf(entry);
      if (recap) {
        blocks.push({ kind: "recap", label: recap.text });
        continue;
      }
      const hook = loopHookOf(entry);
      if (hook) {
        blocks.push({ kind: "hook", label: hook.text });
        continue;
      }
      const thinking = loopThinkingOf(entry);
      if (thinking) {
        blocks.push({
          kind: "thinking",
          label:
            thinking.durationMs !== undefined
              ? `Thought for ${thinking.durationMs}ms`
              : thinking.streaming
                ? "Thinking…"
                : "Thought",
          thinking: {
            text: thinking.text,
            streaming: thinking.streaming,
            ...(thinking.durationMs === undefined ? {} : { durationMs: thinking.durationMs }),
          },
        });
        continue;
      }
      const tool = loopToolOf(entry);
      if (tool) {
        const summary = formatToolArgs(tool.name, tool.args, cwd);
        const range = tool.name === "read" ? readLineRangeText(tool.args) : "";
        blocks.push({
          kind: "tool",
          label: `${tool.name}${summary ? ` ${summary}${range}` : ""}`,
          tool: {
            name: tool.name,
            summary: `${summary}${range}`,
            state: toolState(tool),
            ...(tool.output === undefined ? {} : { output: tool.output }),
            ...(tool.streamingContent === undefined
              ? {}
              : { streamingContent: tool.streamingContent }),
            ...(tool.name === "task"
              ? {
                  status: formatTaskStatus({
                    isPartial: tool.isPartial,
                    interrupted: tool.interrupted === true,
                    isError: tool.isError,
                    ...(tool.statusText === undefined ? {} : { statusText: tool.statusText }),
                    stats: tool.stats,
                  }),
                }
              : {}),
            ...(tool.activity === undefined
              ? {}
              : {
                  activity: tool.activity.map((step) =>
                    step.kind === "tool"
                      ? `${step.name} ${
                          step.summary ??
                          formatToolArgs(
                            step.name,
                            typeof step.input === "object" && step.input !== null
                              ? (step.input as Record<string, unknown>)
                              : {},
                            cwd,
                          )
                        }`.trim()
                      : `${step.kind} ${step.text}`,
                  ),
                }),
          },
        });
        continue;
      }
      blocks.push({ kind: "other", label: entry.label });
    }
  }
  return blocks;
}

/** `["user hi", "thinking Thought", "tool bash wc -l", "assistant done"]`. */
function shapeOf(rows: readonly MessagesTimelineRow[], cwd: string): string[] {
  return describeRows(rows, cwd).map((block) => `${block.kind} ${block.label}`.trim());
}
