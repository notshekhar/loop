/**
 * Reading the loop-shaped payload off a work entry.
 *
 * The payload crosses an `unknown` boundary — `session-logic.ts` carries it
 * without looking inside — so it is narrowed here, once, and the components
 * get types. Anything malformed comes back null and the generic row renders
 * instead, which is the right fallback: a thread from before this existed, or
 * an activity from some other source, must still draw.
 */

/** One line of a subagent's nested log inside a `task` row. */
export type LoopSubagentStep =
  | {
      readonly kind: "tool";
      readonly name: string;
      /** A live run carries the raw input and the row formats it. */
      readonly input?: unknown;
      /** A replayed run carries loop's own pre-formatted argument line. */
      readonly summary?: string;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string };

export interface LoopToolEntry {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly output?: string;
  readonly isError: boolean;
  readonly isPartial: boolean;
  readonly interrupted?: boolean;
  readonly streamingContent?: string;
  readonly agent?: string;
  readonly statusText?: string;
  readonly stats?: { steps?: number; durationMs?: number; usd?: number };
  /** Epoch ms the call began — a running row clocks itself from this, since
   * `stats.durationMs` only exists once it has ended. */
  readonly startedAt?: number;
  readonly activity?: readonly LoopSubagentStep[];
  readonly droppedActivity?: number;
}

export interface LoopThinkingEntry {
  readonly text: string;
  readonly durationMs?: number;
  readonly streaming: boolean;
}

export interface LoopRecapEntry {
  readonly text: string;
}

/** One line a hook wrote, as the transcript row reads it. */
export interface LoopHookEntry {
  readonly text: string;
}

/** A context compaction, as the transcript row reads it. */
export interface LoopCompactEntry {
  readonly reason?: string;
  readonly running: boolean;
  readonly summary?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly aborted?: boolean;
  readonly error?: string;
}

/** A teammate on a team card: loop's session id and the id this client routes by. */
export interface LoopTeamPeer {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
}

/** Something the thread team wrote into this thread (a brief, mail). */
export interface LoopTeamEntry {
  readonly kind: "spawn" | "mail";
  readonly teamId: string;
  readonly from?: LoopTeamPeer;
  readonly title?: string;
  readonly text?: string;
  readonly mail?: ReadonlyArray<{
    readonly id: number;
    readonly from: LoopTeamPeer;
    readonly kind: "message" | "report" | "update";
    readonly text: string;
    readonly ts: number;
  }>;
  readonly midTurn?: boolean;
}

interface LoopCarrier {
  readonly loop?: {
    tool?: unknown;
    thinking?: unknown;
    recap?: unknown;
    compact?: unknown;
    hook?: unknown;
    team?: unknown;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function loopToolOf(entry: LoopCarrier): LoopToolEntry | null {
  const tool = record(entry.loop?.tool);
  if (!tool || typeof tool.name !== "string") return null;
  const stats = record(tool.stats);
  const activity = subagentSteps(tool.activity);
  return {
    name: tool.name,
    args: record(tool.args) ?? {},
    ...(typeof tool.output === "string" ? { output: tool.output } : {}),
    isError: tool.isError === true,
    isPartial: tool.isPartial === true,
    ...(tool.interrupted === true ? { interrupted: true } : {}),
    ...(typeof tool.streamingContent === "string"
      ? { streamingContent: tool.streamingContent }
      : {}),
    ...(typeof tool.agent === "string" ? { agent: tool.agent } : {}),
    ...(typeof tool.statusText === "string" ? { statusText: tool.statusText } : {}),
    ...(stats ? { stats: stats as NonNullable<LoopToolEntry["stats"]> } : {}),
    ...(typeof tool.startedAt === "number" ? { startedAt: tool.startedAt } : {}),
    ...(activity.length === 0 ? {} : { activity }),
    ...(typeof tool.droppedActivity === "number" && tool.droppedActivity > 0
      ? { droppedActivity: tool.droppedActivity }
      : {}),
  };
}

/**
 * Narrow the subagent log. A malformed step is dropped rather than rendered,
 * on the same principle as the payload as a whole: the row must still draw.
 */
function subagentSteps(value: unknown): readonly LoopSubagentStep[] {
  if (!Array.isArray(value)) return [];
  const steps: LoopSubagentStep[] = [];
  for (const raw of value) {
    const step = record(raw);
    if (!step) continue;
    if (step.kind === "tool" && typeof step.name === "string") {
      steps.push({
        kind: "tool",
        name: step.name,
        ...(step.input === undefined ? {} : { input: step.input }),
        ...(typeof step.summary === "string" ? { summary: step.summary } : {}),
      });
    } else if (step.kind === "text" && typeof step.text === "string") {
      steps.push({ kind: "text", text: step.text });
    } else if (step.kind === "thinking" && typeof step.text === "string") {
      steps.push({ kind: "thinking", text: step.text });
    }
  }
  return steps;
}

export function loopThinkingOf(entry: LoopCarrier): LoopThinkingEntry | null {
  const thinking = record(entry.loop?.thinking);
  if (!thinking || typeof thinking.text !== "string") return null;
  return {
    text: thinking.text,
    ...(typeof thinking.durationMs === "number" ? { durationMs: thinking.durationMs } : {}),
    streaming: thinking.streaming === true,
  };
}

export function loopCompactOf(entry: LoopCarrier): LoopCompactEntry | null {
  const compact = record(entry.loop?.compact);
  if (!compact) return null;
  return {
    ...(typeof compact.reason === "string" ? { reason: compact.reason } : {}),
    running: compact.running === true,
    ...(typeof compact.summary === "string" && compact.summary.trim() !== ""
      ? { summary: compact.summary }
      : {}),
    ...(typeof compact.tokensBefore === "number" ? { tokensBefore: compact.tokensBefore } : {}),
    ...(typeof compact.tokensAfter === "number" ? { tokensAfter: compact.tokensAfter } : {}),
    ...(compact.aborted === true ? { aborted: true } : {}),
    ...(typeof compact.error === "string" ? { error: compact.error } : {}),
  };
}

export function loopRecapOf(entry: LoopCarrier): LoopRecapEntry | null {
  const recap = record(entry.loop?.recap);
  if (!recap || typeof recap.text !== "string" || recap.text.trim() === "") return null;
  return { text: recap.text };
}

export function loopHookOf(entry: LoopCarrier): LoopHookEntry | null {
  const hook = record(entry.loop?.hook);
  if (!hook || typeof hook.text !== "string" || hook.text.trim() === "") return null;
  return { text: hook.text };
}

function peerOf(value: unknown): LoopTeamPeer | null {
  const peer = record(value);
  if (!peer || typeof peer.id !== "string") return null;
  return {
    id: peer.id,
    threadId: typeof peer.threadId === "string" ? peer.threadId : peer.id,
    title: typeof peer.title === "string" && peer.title.trim() ? peer.title : "a thread",
  };
}

export function loopTeamOf(entry: LoopCarrier): LoopTeamEntry | null {
  const team = record(entry.loop?.team);
  if (!team || (team.kind !== "spawn" && team.kind !== "mail") || typeof team.teamId !== "string") return null;
  const from = peerOf(team.from);
  const mail = Array.isArray(team.mail)
    ? team.mail.flatMap((raw) => {
        const item = record(raw);
        const sender = peerOf(item?.from);
        if (!item || !sender || typeof item.text !== "string") return [];
        const kind: "message" | "report" | "update" =
          item.kind === "report" || item.kind === "update" ? item.kind : "message";
        return [{ id: typeof item.id === "number" ? item.id : 0, from: sender, kind, text: item.text, ts: typeof item.ts === "number" ? item.ts : 0 }];
      })
    : undefined;
  return {
    kind: team.kind,
    teamId: team.teamId,
    ...(from ? { from } : {}),
    ...(typeof team.title === "string" ? { title: team.title } : {}),
    ...(typeof team.text === "string" ? { text: team.text } : {}),
    ...(mail ? { mail } : {}),
    ...(team.midTurn === true ? { midTurn: true } : {}),
  };
}
