/**
 * The in-flight turn.
 *
 * loop persists a turn to its transcript only once the turn ends, so
 * `session.history` cannot show a reply as it is being written. The live text,
 * the thinking and the tool calls arrive instead as `session.event`
 * notifications, and this module is where they accumulate until the transcript
 * catches up.
 *
 * It is deliberately a plain observable store rather than anything Effect-
 * shaped: it is fed by a socket callback, read from a stream handler, and both
 * want the same mutable snapshot.
 */
import { formatError } from "./formatError.ts";
import { toolStreamsItsInput } from "./streamingInput.ts";
import { defaultLoopHost, type LoopHost } from "../transport.ts";

/**
 * One thing a subagent did, as it happens.
 *
 * The terminal renders these inside the task tool's own box — a `> tool args`
 * line per call, the agent's prose in between — and that nesting is the whole
 * point of the row: a `task` that only says "running" for two minutes tells
 * you nothing about whether it is stuck. loop already emits every piece
 * (`subagent-tool`, `subagent-delta`); nothing here needed a new event.
 */
export type LiveSubagentStep =
  /** `summary` is the pre-formatted argument line a REPLAYED run carries
   * (loop's persisted `subagent` entry stores a summary, not the raw input);
   * a live run carries `input` and the row formats it itself. */
  | { readonly kind: "tool"; readonly name: string; readonly input?: unknown; readonly summary?: string }
  | { kind: "text"; text: string }
  | { readonly kind: "thinking"; readonly text: string };

/**
 * Cap on retained subagent steps per task.
 *
 * A long subagent run is unbounded, and every step is held for the whole turn.
 * The oldest are dropped; the row says how many, so a truncated log never
 * pretends to be complete. The terminal caps the same buffer by bytes.
 */
export const MAX_SUBAGENT_STEPS = 60;

/** One checklist item; mirrors core's `TodoItem` (tools/todo.ts). */
export interface LiveTodo {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  /** Present-continuous label shown while in progress ("Adding middleware"). */
  readonly activeForm?: string;
}

export interface LiveToolCall {
  readonly id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  done: boolean;
  /**
   * Raw JSON of the input as it streams, before `tool-call` delivers it parsed.
   * Only write/edit/plan buffer it — the same set the terminal buffers — and
   * it is what the live file-content preview is rendered from.
   */
  inputBuffer?: string;
  /**
   * The input came from `tool-input-updated`, i.e. a hook rewrote it.
   *
   * MEASURED on a real turn: a hook turned `cat poem.txt` into
   * `rtk read poem.txt`, and because the raw `tool-call` part lands after the
   * rewrite and carries the model's ORIGINAL arguments, the row showed a
   * command that never ran. The rewritten input is the one that executes, so
   * it wins.
   */
  inputFromHook?: boolean;
  /** Subagent (task) live state, from the `subagent-*` events. */
  agent?: string;
  statusText?: string;
  steps?: number;
  usd?: number;
  /** What the subagent has done so far, newest last. */
  activity?: LiveSubagentStep[];
  /** Steps dropped off the front of `activity` by the cap. */
  droppedActivity?: number;
  startedAt: number;
  /** Position in the turn; see `seq` on LiveTurn. */
  seq: number;
  endedAt?: number;
}

/**
 * One reasoning block.
 *
 * A turn can think more than once — before a tool, then again after its result
 * — and the terminal renders each as its own `◆ Thought for 1.2s` row. Holding
 * them as blocks rather than one concatenated string is what makes that, and
 * the duration, possible.
 */
export interface LiveThinking {
  text: string;
  startedAt: number;
  /** Position in the turn; see `seq` on LiveTurn. */
  seq: number;
  endedAt?: number;
}

/**
 * A run of assistant text, and when it started.
 *
 * One turn writes text more than once — a line before a tool, the summary
 * after it — and the terminal prints each run where it happened. Held as
 * separate runs so the transcript can too; concatenating them into one block
 * forces the whole reply to render either above or below every tool call.
 */
export interface LiveText {
  text: string;
  startedAt: number;
  /** Position in the turn; see `seq` on LiveTurn. */
  seq: number;
  /** Cleared when a tool interrupts, so later text starts a new run. */
  open: boolean;
}

/**
 * A compaction, live.
 *
 * loop compacts either on its own (`autoCompactThreshold`, mid-turn) or
 * because someone asked (`session.compact`), and both announce themselves with
 * `compact-start`/`compact-end`. It matters visibly: the summary REPLACES
 * everything before the cut in the model's context, so a conversation that
 * silently loses its earlier half looks like the agent forgetting.
 */
export interface LiveCompaction {
  /** loop's own word: `auto` or `manual`. */
  readonly reason: string;
  running: boolean;
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  /** Cancelled or failed — no summary was written. */
  aborted?: boolean;
  /** Why it failed, when it did; the turn carried on uncompacted. */
  error?: string;
  /** Position in the turn; see `seq` on LiveTurn. */
  readonly seq: number;
  readonly startedAt: number;
}

/**
 * A line a hook wrote, live.
 *
 * Hooks run on the user's own machine and speak to the user — "formatter
 * rewrote 3 files", "blocked: do not touch main". The terminal prints each
 * into the transcript (`history.addHook`); the app dropped the event, so a
 * hook that silently rewrote or refused a tool call left no trace at all.
 */
export interface LiveHook {
  readonly text: string;
  /** Position in the turn; see `seq` on LiveTurn. */
  readonly seq: number;
  readonly startedAt: number;
}

/**
 * Spend and context as of the turn's most recent step.
 *
 * `breakdown` is the tracker's running SESSION total, not this step's slice —
 * `CostTracker.add` returns the accumulated figure — so it is exactly what the
 * usage readout shows, without a re-read. `usage` is the step's own block, and
 * its `inputTokens` is the size of the prompt that step sent, which is the
 * closest thing to "how full is the context right now" available mid-turn.
 */
export interface LiveUsage {
  readonly usd?: number;
  readonly estimated?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  /** Prompt + completion of the last step — the live context estimate. */
  readonly contextTokens?: number;
}

/** A question the agent is waiting on, from loop's `ask` event. */
export interface LiveAsk {
  readonly askId: string;
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { readonly label: string; readonly description: string }[];
    readonly multiSelect?: boolean;
  }[];
}

export interface LiveTurn {
  /** Assistant text runs, in the order they were written. */
  readonly texts: LiveText[];
  /** Reasoning blocks in the order loop reported them. */
  readonly thinking: LiveThinking[];
  /** Tool calls in the order loop reported them. */
  readonly tools: LiveToolCall[];
  /** Set when the turn ended with an error. */
  error?: string;
  /** Post-turn recap, when recaps are enabled. Arrives after `finish`. */
  recap?: string;
  /** Set while the agent is waiting on an answer; cleared when one is sent. */
  ask?: LiveAsk;
  /** Compactions during this turn, in order. */
  readonly compactions: LiveCompaction[];
  /** Hook output during this turn, in order. */
  readonly hooks: LiveHook[];
  /** Spend and context as of the latest `step-usage`. */
  usage?: LiveUsage;
  /**
   * The agent's checklist, as of its most recent `todo` write.
   *
   * Current state, not history: every write REPLACES the whole list (the tool
   * has no ids and no diff ops — the model just restates it), so only the
   * latest matters. That is also why it is a field rather than an array of
   * events, and why the CLI pins one panel instead of logging each write.
   */
  todos?: readonly LiveTodo[];
  running: boolean;
  /** Bumped on every mutation, so a reader can tell "changed" from "same". */
  revision: number;
  /**
   * Bumped only by events that can add to loop's PERSISTED transcript.
   *
   * `text-delta`, `reasoning-delta` and `tool-input-delta` are pure overlay:
   * they extend a block this file already holds, and loop writes nothing to
   * the session until the message they belong to is complete. Every other
   * event either closes a message or is one.
   *
   * That distinction is what lets `thread.ts` reuse the history it already
   * fetched instead of re-reading the whole transcript twelve times a second
   * while the model thinks — which is the entire cost of rendering a long
   * reasoning stream, since the transcript is megabytes and the deltas are
   * bytes.
   */
  historyRevision: number;
  /**
   * Handed to each block as it is created, so the three arrays can be merged
   * back into arrival order.
   *
   * Wall-clock time cannot do this: several events routinely land in the same
   * millisecond, and sorting on it then falls back to which array was walked
   * first — which rendered every text run before every tool call regardless of
   * what happened.
   */
  seq: number;
  startedAt: string;
  /**
   * Epoch ms of the last event applied — the turn's pulse.
   *
   * `running` closes only on `finish`/`error`, so a turn whose end never
   * reaches this client stays "running" forever: the composer keeps its Stop
   * button and the transcript keeps counting "Working for 12m". Nothing else
   * can notice, because `threadStream` only rebuilds when a live turn CHANGES —
   * a turn that has stopped changing stops being re-examined.
   *
   * This is what lets the watchdog tell "the model is thinking" (silent, but
   * loop still says running) from "the end was lost" (silent, and loop says
   * idle). See `liveTurnIsQuiet`.
   */
  lastEventAt: number;
}

/**
 * `structural` is false for the pure-delta events — text, reasoning and
 * tool-input — that only extend a block already held here.
 *
 * MEASURED, and this is why the flag exists rather than being inferred: kimi
 * streams one `write` as ~2600 `tool-input-delta` events, and EVERY listener
 * ran on every one of them. The shell's listener rebuilds the whole sidebar
 * (a `session.list` across every project), which a delta cannot possibly have
 * changed — so the renderer spent the entire stream re-listing sessions and
 * froze for 22 seconds at a stretch. A subscriber that only cares about what
 * the conversation IS can now ignore the ones that only change how much of it
 * has been written.
 */
type Listener = (sessionId: string, structural: boolean, lifecycle: boolean) => void;

/*
 * `lifecycle` is narrower still: true only when what a session list shows can
 * have changed — a turn started or ended, a question opened or closed, or a
 * caller said the session itself changed (rename, archive, delete).
 *
 * MEASURED in the desktop app: the shell listener rebuilt the sidebar on every
 * STRUCTURAL event, and with a few hundred sessions each rebuild invalidated
 * every thread's atom and re-rendered the sidebar — 200–300ms of blocked main
 * thread per tool call. A tool-heavy reply hit that several times a second,
 * which is the typing lag. A tool call changes nothing the sidebar draws.
 */

/** What the session list shows of a turn, to tell a lifecycle change from content. */
const lifecycleShown = new Map<string, string>();
function lifecycleOf(turn: LiveTurn | undefined): string {
  return turn === undefined ? "none" : `${turn.running ? "running" : "ended"}:${turn.ask ? "ask" : ""}`;
}
/** Record what is shown now; true when it differs from what was shown before. */
function lifecycleMoved(sessionId: string): boolean {
  const now = lifecycleOf(turns.get(sessionId));
  const moved = lifecycleShown.get(sessionId) !== now;
  lifecycleShown.set(sessionId, now);
  return moved;
}
function notify(sessionId: string, structural: boolean, lifecycle: boolean): void {
  for (const listener of listeners) listener(sessionId, structural, lifecycle);
}

/**
 * The highest `session.event` seq applied per session.
 *
 * Kept outside the turn because it outlives one: it is what `session.attach`
 * resumes from, and a client that reattaches has to say where it got to or the
 * server sends nothing. Never cleared when the turn is — the counter is the
 * server's, and rewinding it would replay events already rendered.
 */
const lastSeqs = new Map<string, number>();

const turns = new Map<string, LiveTurn>();
const listeners = new Set<Listener>();
/** Hosts whose event stream feeds the turns above. Session ids are unique
 * across hosts, so one table serves them all. */
const subscribedHosts = new Set<string>();

/** Everything the turn has said, for comparing against the transcript. */
export function liveTurnText(turn: LiveTurn): string {
  return turn.texts.map((run) => run.text).join("");
}

function openText(turn: LiveTurn): LiveText {
  const last = turn.texts[turn.texts.length - 1];
  if (last?.open) return last;
  const created: LiveText = { text: "", startedAt: Date.now(), seq: turn.seq++, open: true };
  turn.texts.push(created);
  return created;
}

function emptyTurn(): LiveTurn {
  return {
    texts: [],
    thinking: [],
    tools: [],
    compactions: [],
    hooks: [],
    running: true,
    revision: 0,
    historyRevision: 0,
    seq: 0,
    startedAt: new Date().toISOString(),
    lastEventAt: Date.now(),
  };
}

/**
 * Apply a mutation and wake the listeners.
 *
 * `structural` is false for the three delta events that only extend a block
 * already held here — see `LiveTurn.historyRevision`.
 */
function touch(
  sessionId: string,
  mutate: (turn: LiveTurn) => void,
  structural = true,
): void {
  const existing = turns.get(sessionId) ?? emptyTurn();
  mutate(existing);
  existing.revision += 1;
  existing.lastEventAt = Date.now();
  if (structural) existing.historyRevision += 1;
  turns.set(sessionId, existing);
  notify(sessionId, structural, lifecycleMoved(sessionId));
}

/**
 * Everything that must be true once a turn is over, whatever ended it.
 *
 * Shared by the `finish` event and the watchdog below, because a turn closed
 * because loop says it is over has to leave exactly the same state behind as
 * one closed by its own end event — otherwise the spinner moves from the turn
 * to a thinking block and nothing looks fixed.
 */
function closeTurn(turn: LiveTurn): void {
  turn.running = false;
  // An ended turn writes nothing more: whatever arrives next is another turn.
  const text = turn.texts[turn.texts.length - 1];
  if (text) text.open = false;
  // A turn cannot end still waiting on an answer.
  delete turn.ask;
  // Close anything still open, or a thinking block that was interrupted
  // by the turn ending would stream a spinner forever.
  const open = turn.thinking[turn.thinking.length - 1];
  if (open && open.endedAt === undefined) open.endedAt = Date.now();
  // Same for a compaction the turn was aborted during: runTurn emits
  // `compact-end` on abort, but a dropped connection would not.
  for (const compaction of turn.compactions) {
    if (compaction.running) {
      compaction.running = false;
      compaction.aborted = true;
    }
  }
}

function toolFor(turn: LiveTurn, id: string): LiveToolCall {
  const found = turn.tools.find((tool) => tool.id === id);
  if (found) return found;
  const created: LiveToolCall = {
    id,
    name: "",
    input: undefined,
    done: false,
    startedAt: Date.now(),
    seq: turn.seq++,
  };
  turn.tools.push(created);
  return created;
}

/**
 * The reasoning block currently being written.
 *
 * Opened lazily by the first delta rather than only by `reasoning-start`:
 * not every provider emits the start event, and a block that never opens
 * silently drops the model's thinking.
 */
function openThinking(turn: LiveTurn): LiveThinking {
  const last = turn.thinking[turn.thinking.length - 1];
  if (last && last.endedAt === undefined) return last;
  const created: LiveThinking = { text: "", startedAt: Date.now(), seq: turn.seq++ };
  turn.thinking.push(created);
  return created;
}

/** Append a subagent step, dropping the oldest once the cap is reached. */
function pushSubagentStep(tool: LiveToolCall, step: LiveSubagentStep): void {
  const activity = (tool.activity ??= []);
  activity.push(step);
  while (activity.length > MAX_SUBAGENT_STEPS) {
    activity.shift();
    tool.droppedActivity = (tool.droppedActivity ?? 0) + 1;
  }
}

/** Shape of one `session.event` notification's `part`. */
interface LoopTurnPart {
  readonly type: string;
  readonly data?: unknown;
}

/**
 * Fold one `session.event` part into the live turn.
 *
 * Exported because it is the whole contract with loop's event stream: the
 * transport calls it for every notification, and a test feeding it the exact
 * wire shape is testing the real path rather than a paraphrase of it.
 */
export function applyLoopEvent(sessionId: string, part: LoopTurnPart): void {
  apply(sessionId, part);
}

/**
 * Events that are the turn itself writing — as opposed to what trails a turn
 * after it ends (recap, usage, the running flag). One of these reaching a
 * turn that has already ended belongs to the NEXT turn.
 */
const TURN_CONTENT_EVENTS: ReadonlySet<string> = new Set([
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-call",
  "hook-message",
  "compact-start",
]);

function apply(sessionId: string, part: LoopTurnPart): void {
  // A turn this client did not dispatch has no `beginLiveTurn` — one replayed
  // from the server's ring after a reload, one started by a queue drain or
  // another client. Folding its events into the ended turn before it merged
  // consecutive replies into one paragraph that never matched the transcript,
  // so it outlived every turn in it.
  if (TURN_CONTENT_EVENTS.has(part.type) && turns.get(sessionId)?.running === false) {
    turns.set(sessionId, emptyTurn());
  }
  const data = part.data as Record<string, unknown> | string | undefined;
  switch (part.type) {
    case "text-delta":
      touch(
        sessionId,
        (turn) => {
          openText(turn).text += typeof data === "string" ? data : "";
        },
        false,
      );
      return;
    case "reasoning-start":
      touch(sessionId, (turn) => {
        openThinking(turn);
      });
      return;
    case "reasoning-delta":
      touch(
        sessionId,
        (turn) => {
          openThinking(turn).text += typeof data === "string" ? data : "";
        },
        false,
      );
      return;
    case "reasoning-end":
      touch(sessionId, (turn) => {
        const open = turn.thinking[turn.thinking.length - 1];
        if (open && open.endedAt === undefined) open.endedAt = Date.now();
      });
      return;
    case "tool-input-start":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; toolName?: string };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        tool.name = record.toolName ?? "";
        // A tool starting its input ends any open thinking: the terminal shows
        // "Thought for 1.2s" at that moment, not when the whole turn finishes.
        const open = turn.thinking[turn.thinking.length - 1];
        if (open && open.endedAt === undefined) open.endedAt = Date.now();
        // It also ends the current run of text, so anything the model writes
        // after this tool renders below it rather than merging with what came
        // before.
        const text = turn.texts[turn.texts.length - 1];
        if (text) text.open = false;
        if (toolStreamsItsInput(tool.name)) tool.inputBuffer = "";
      });
      return;
    case "tool-input-delta":
      touch(
        sessionId,
        (turn) => {
          const record = data as { toolCallId?: string; delta?: string };
          if (!record?.toolCallId || typeof record.delta !== "string") return;
          const tool = toolFor(turn, record.toolCallId);
          if (tool.inputBuffer === undefined) return;
          tool.inputBuffer += record.delta;
        },
        false,
      );
      return;
    case "tool-call":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; toolName?: string; input?: unknown };
        if (!record?.toolCallId) return;
        // A call can arrive without its `tool-input-start` (a provider that
        // reports finished calls only). Opening its row must still end the
        // text and thinking before it, exactly as the start event would —
        // otherwise the next sentence streams into the paragraph above it.
        if (!turn.tools.some((existing) => existing.id === record.toolCallId)) {
          const open = turn.thinking[turn.thinking.length - 1];
          if (open && open.endedAt === undefined) open.endedAt = Date.now();
          const text = turn.texts[turn.texts.length - 1];
          if (text) text.open = false;
        }
        const tool = toolFor(turn, record.toolCallId);
        if (record.toolName) tool.name = record.toolName;
        // A hook has already rewritten this call's arguments, and the rewrite
        // is what loop will execute. This part carries the model's original
        // ones — the two events race, and letting the raw one land last showed
        // a command that never ran.
        if (!tool.inputFromHook) tool.input = record.input;
      });
      return;
    case "tool-input-updated":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; toolName?: string; input?: unknown };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        if (record.toolName) tool.name = record.toolName;
        tool.input = record.input;
        tool.inputFromHook = true;
      });
      return;
    case "hook-message":
      touch(sessionId, (turn) => {
        const text = typeof data === "string" ? data : "";
        if (text.trim() === "") return;
        turn.hooks.push({ text, seq: turn.seq++, startedAt: Date.now() });
      });
      return;
    case "step-usage":
      // Cost and context, per step — the terminal refreshes its status line
      // here. Not structural: it adds nothing to the transcript, and marking
      // it so would re-read the whole session on every step.
      touch(
        sessionId,
        (turn) => {
          const record = data as
            | {
                usage?: {
                  inputTokens?: number;
                  outputTokens?: number;
                  cachedInputTokens?: number;
                  inputTokenDetails?: { cacheReadTokens?: number };
                };
                breakdown?: {
                  usd?: number;
                  inputTokens?: number;
                  outputTokens?: number;
                  cachedInputTokens?: number;
                  estimated?: boolean;
                };
              }
            | undefined;
          if (!record) return;
          const usage = record.usage;
          const breakdown = record.breakdown;
          const contextTokens =
            usage === undefined
              ? undefined
              : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          turn.usage = {
            ...(breakdown?.usd === undefined ? {} : { usd: breakdown.usd }),
            ...(breakdown?.estimated === undefined ? {} : { estimated: breakdown.estimated }),
            ...(breakdown?.inputTokens === undefined ? {} : { inputTokens: breakdown.inputTokens }),
            ...(breakdown?.outputTokens === undefined
              ? {}
              : { outputTokens: breakdown.outputTokens }),
            ...(breakdown?.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: breakdown.cachedInputTokens }),
            ...(contextTokens === undefined || contextTokens === 0 ? {} : { contextTokens }),
          };
        },
        false,
      );
      return;
    case "todo-update":
      // Replaces rather than merges: the tool's contract is that each call
      // restates the complete list, so anything kept from the previous one
      // would resurrect an item the model deliberately dropped.
      touch(sessionId, (turn) => {
        const record = data as { items?: unknown };
        if (!Array.isArray(record?.items)) return;
        turn.todos = record.items.filter(
          (item): item is LiveTodo =>
            !!item && typeof (item as LiveTodo).content === "string",
        );
      });
      return;
    case "subagent-tool":
      // The task row's live status is the subagent's current tool, the same
      // thing the terminal shows after the agent name — and the call also
      // joins the nested log, which is what makes the row readable rather
      // than just alive.
      touch(sessionId, (turn) => {
        const record = data as {
          toolCallId?: string;
          agent?: string;
          toolName?: string;
          input?: unknown;
        };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        if (record.agent) tool.agent = record.agent;
        if (record.toolName) tool.statusText = record.toolName;
        pushSubagentStep(tool, {
          kind: "tool",
          name: record.toolName ?? "tool",
          input: record.input,
        });
      });
      return;
    case "subagent-delta":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; agent?: string; text?: string };
        if (!record?.toolCallId || typeof record.text !== "string" || record.text === "") return;
        const tool = toolFor(turn, record.toolCallId);
        if (record.agent) tool.agent = record.agent;
        // Deltas arrive per token, so they merge into the trailing text step
        // rather than each becoming a line of their own. A tool call in
        // between closes the run, exactly as it does for the main turn.
        const activity = (tool.activity ??= []);
        const last = activity[activity.length - 1];
        if (last?.kind === "text") last.text += record.text;
        else pushSubagentStep(tool, { kind: "text", text: record.text });
      });
      return;
    case "subagent-finish":
      // The subagent is done, but the task tool has NOT returned yet — its
      // result still has to travel back to the parent. Recording the agent
      // keeps the row named after the finish rather than falling back to
      // "default" if no earlier event carried it.
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; agent?: string };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        if (record.agent) tool.agent = record.agent;
        tool.statusText = "finishing";
      });
      return;
    case "subagent-step-usage":
      touch(sessionId, (turn) => {
        const record = data as {
          toolCallId?: string;
          agent?: string;
          steps?: number;
          usd?: number;
        };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        if (record.agent) tool.agent = record.agent;
        if (typeof record.steps === "number") tool.steps = record.steps;
        if (typeof record.usd === "number") tool.usd = record.usd;
      });
      return;
    case "compact-start":
      touch(sessionId, (turn) => {
        const record = data as { reason?: string } | undefined;
        turn.compactions.push({
          reason: typeof record?.reason === "string" ? record.reason : "auto",
          running: true,
          seq: turn.seq++,
          startedAt: Date.now(),
        });
      });
      return;
    case "compact-end":
      touch(sessionId, (turn) => {
        const record = data as
          | {
              summary?: string;
              tokensBefore?: number;
              tokensAfter?: number;
              aborted?: boolean;
              error?: string;
            }
          | undefined;
        // Closes the open one rather than the last one: a `compact-end` with
        // nothing open would otherwise reopen a settled row as it rewrote it.
        const open = turn.compactions.findLast((entry) => entry.running);
        if (!open) return;
        open.running = false;
        if (typeof record?.summary === "string") open.summary = record.summary;
        if (typeof record?.tokensBefore === "number") open.tokensBefore = record.tokensBefore;
        if (typeof record?.tokensAfter === "number") open.tokensAfter = record.tokensAfter;
        if (record?.aborted === true) open.aborted = true;
        if (typeof record?.error === "string") open.error = record.error;
      });
      return;
    case "ask":
      touch(sessionId, (turn) => {
        const record = data as LiveAsk | undefined;
        if (!record?.askId || !Array.isArray(record.questions)) return;
        turn.ask = record;
      });
      return;
    case "data-recap":
      touch(sessionId, (turn) => {
        const record = data as { text?: string };
        if (typeof record?.text === "string" && record.text.trim() !== "") {
          turn.recap = record.text;
        }
      });
      return;
    case "tool-result":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; output?: unknown };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        tool.endedAt = Date.now();
        tool.output = record.output;
        tool.done = true;
      });
      return;
    case "tool-error":
      touch(sessionId, (turn) => {
        const record = data as { toolCallId?: string; toolName?: string; error?: unknown };
        if (!record?.toolCallId) return;
        const tool = toolFor(turn, record.toolCallId);
        if (record.toolName) tool.name = record.toolName;
        tool.endedAt = Date.now();
        tool.error = record.error;
        tool.done = true;
      });
      return;
    case "error":
      touch(sessionId, (turn) => {
        // Not JSON.stringify: an AI_APICallError serialises to kilobytes of
        // request dump with the one readable line buried in `responseBody`,
        // and a plain Error serialises to `{}`. The terminal has never shown
        // either — it runs the same formatter this does.
        turn.error = formatError(data);
        turn.running = false;
      });
      return;
    case "finish":
      // The transcript now has the whole turn, so the live copy stops being
      // the source of truth. It is kept (not deleted) until the next history
      // read replaces it, or the reply would blank out for a frame.
      touch(sessionId, closeTurn);
      return;
    /**
     * loop's own turn flag, which outranks everything above.
     *
     * `finish` says "the model produced an end"; this says "the server is no
     * longer executing". They normally arrive together, and when they don't it
     * is because `finish` was lost — a dropped socket, a resync past the ring,
     * an abort that unwound before the emitter ran. That is precisely the case
     * that used to strand the composer on Stop and the timeline on "Working
     * for 12m" until the view was remounted, because every other signal here
     * is derived from a stream that can miss a message. This one is set in the
     * server's `finally`, so it cannot be.
     */
    case "session-running":
      if ((data as { running?: boolean })?.running === false) touch(sessionId, closeTurn);
      return;
    default:
      return;
  }
}

/** Feed `host`'s turn events into the live turns. Idempotent per host. */
export function subscribeLiveTurns(host: LoopHost = defaultLoopHost): void {
  if (subscribedHosts.has(host.id)) return;
  subscribedHosts.add(host.id);
  host.onEvent((event) => {
    const part = event.part as LoopTurnPart | undefined;
    if (!part || typeof part.type !== "string") return;
    if (typeof event.seq === "number") {
      // Guarded so a replayed event that arrives out of order cannot rewind
      // the resume point and make the next attach ask for it all again.
      const seen = lastSeqs.get(event.sessionId) ?? 0;
      if (event.seq > seen) lastSeqs.set(event.sessionId, event.seq);
    }
    apply(event.sessionId, part);
  });
}

/**
 * The last event seq applied for a session, for `session.attach {afterSeq}`.
 *
 * 0 means "everything you still have": loop keeps a ring of the last events
 * per session and replays what follows the seq it is given, which is how a
 * client that arrives mid-turn learns what has happened so far.
 */
export function lastEventSeq(sessionId: string): number {
  return lastSeqs.get(sessionId) ?? 0;
}

/**
 * Forget the resume point, so the next attach asks for the whole ring again.
 *
 * Called when loop answers an attach with `resync`: the gap was bigger than
 * the ring, so what this client holds cannot be trusted to be contiguous.
 */
export function forgetEventSeq(sessionId: string): void {
  lastSeqs.delete(sessionId);
}

/**
 * Adopt a turn this client did not start.
 *
 * loop persists nothing until a turn ends, so a session that is already
 * running when the thread is opened — started in the terminal, in another
 * window, or before this app was restarted — has an empty transcript and no
 * live overlay. It rendered as a finished conversation sitting still while the
 * agent worked, which is the worst thing this view can do. Attaching replays
 * the event ring into a turn; this is what marks it as still going, since the
 * replay's own events cannot say so (an older `finish` in the ring would say
 * the opposite).
 *
 * One-directional on purpose. Only `finish`/`error`, or the transcript
 * catching up, end a turn — a "not running" answer here is routinely just a
 * race with the send that is about to start one, and acting on it would freeze
 * every tool row in the turn as interrupted a moment before it began.
 */
export function adoptRunningTurn(sessionId: string, host: LoopHost = defaultLoopHost): void {
  subscribeLiveTurns(host);
  const existing = turns.get(sessionId);
  if (existing === undefined) {
    turns.set(sessionId, emptyTurn());
    notify(sessionId, true, lifecycleMoved(sessionId));
    return;
  }
  if (existing.running) return;
  touch(sessionId, (turn) => {
    turn.running = true;
  });
}

/**
 * How long a running turn may say nothing before its liveness is doubted.
 *
 * Generous on purpose: a model with a slow first token, a long `bash`, or a
 * subagent working says nothing for a while and is perfectly alive. Being slow
 * costs one extra `session.open` here, so the only thing a long window buys is
 * a longer wait before a genuinely lost turn clears.
 */
const QUIET_MS = 6_000;

/** No event for a while — either deep in thought, or the end was lost. */
export function liveTurnIsQuiet(turn: LiveTurn, now = Date.now()): boolean {
  return now - turn.lastEventAt >= QUIET_MS;
}

/**
 * End a turn because loop says it is no longer running.
 *
 * The counterpart to `adoptRunningTurn`, and deliberately NOT its mirror: that
 * one is one-directional because a "not running" answer racing a send is
 * routine. This is only ever called after the turn has gone quiet, which is
 * what makes the same answer trustworthy — a send that has not registered yet
 * has not been silent for six seconds.
 */
export function endLiveTurn(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (!turn?.running) return;
  touch(sessionId, closeTurn);
}

/**
 * The other answer to the same question: loop says this turn IS still running.
 *
 * Restarts the quiet clock, which is what keeps a genuinely silent turn — a ten
 * minute `bash`, a subagent working — from re-reading the whole transcript
 * every few seconds for as long as it lasts. Deliberately does NOT notify:
 * nothing about the conversation changed, and waking the listeners would be
 * the rebuild this is avoiding.
 */
export function confirmLiveTurnRunning(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (!turn?.running) return;
  turn.lastEventAt = Date.now();
}

/** For each speculative turn a send opened: the turn it displaced. */
const displacedBy = new WeakMap<LiveTurn, LiveTurn | undefined>();
/** Speculative turns whose send loop refused — never worth restoring. */
const abandoned = new WeakSet<LiveTurn>();

/**
 * Start a fresh live turn — called when a turn is dispatched, before the
 * call, so a delta that beats the reply has somewhere to land. Returns the
 * turn so a refused send can take back exactly this one (abandonLiveTurn).
 */
export function beginLiveTurn(sessionId: string, host: LoopHost = defaultLoopHost): LiveTurn {
  subscribeLiveTurns(host);
  const created = emptyTurn();
  displacedBy.set(created, turns.get(sessionId));
  turns.set(sessionId, created);
  lifecycleMoved(sessionId);
  notify(sessionId, true, true);
  return created;
}

/**
 * Undo a `beginLiveTurn` whose send loop refused.
 *
 * Only while that turn still holds the slot. Queued messages put several
 * sends in flight at once — a drain, a retry, Esc's send-now — and a refused
 * one that blindly restored what IT displaced would overwrite the turn a newer
 * accepted send had just opened: that turn's reply then streamed into the
 * previous turn's open paragraph, and the merged text never matched the
 * transcript, so it stayed on screen after every turn had ended.
 */
export function abandonLiveTurn(sessionId: string, turn: LiveTurn): void {
  abandoned.add(turn);
  if (turns.get(sessionId) !== turn) return;
  let back = displacedBy.get(turn);
  while (back !== undefined && abandoned.has(back)) back = displacedBy.get(back);
  restoreLiveTurn(sessionId, back);
}

/** The live turn for a session, if one has been seen. */
export function readLiveTurn(sessionId: string): LiveTurn | undefined {
  subscribeLiveTurns();
  return turns.get(sessionId);
}

/**
 * Put back the turn a `beginLiveTurn` displaced.
 *
 * A send has to open its buffer before the call, or a delta that beats the
 * response is lost — but loop can still refuse the send, and when it refuses
 * because a turn is already running, the buffer just wiped belongs to that
 * turn. Restoring it means a message queued mid-stream costs the reply
 * on screen nothing; without it the response blanks for a frame and resumes
 * halfway through.
 *
 * `undefined` restores "no live turn", which is what a refused send against a
 * session this client had never dispatched for should leave behind.
 */
export function restoreLiveTurn(sessionId: string, turn: LiveTurn | undefined): void {
  if (turn === undefined) turns.delete(sessionId);
  else turns.set(sessionId, turn);
  lifecycleMoved(sessionId);
  notify(sessionId, true, true);
}

/**
 * Drop the live turn once the transcript contains it. Called after a history
 * read that already includes the finished turn.
 */
export function clearLiveTurn(sessionId: string): void {
  turns.delete(sessionId);
}

/** Clear the pending question once its answer has been sent to loop. */
export function clearLiveAsk(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (!turn?.ask) return;
  touch(sessionId, (current) => {
    delete current.ask;
  });
}

/**
 * Tell the thread stream a session's transcript changed for a reason that is
 * not a turn event.
 *
 * `session.branch` is the case this exists for: moving the leaf rewrites which
 * entries the conversation consists of, and loop broadcasts nothing — it is a
 * client asking for it, not the agent doing something. Without this the tree
 * would move underneath a transcript that kept rendering the old branch.
 */
export function notifyThreadChanged(sessionId: string): void {
  notify(sessionId, true, true);
}

/** Notified whenever any live turn changes. Returns an unsubscribe. */
export function onLiveTurnChange(listener: Listener): () => void {
  subscribeLiveTurns();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
