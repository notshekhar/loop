/**
 * `/btw <question>` — loop's side question (packages/core/src/sessions/btw.ts).
 *
 * Typed into a thread's composer, it is NOT sent to that thread: loop copies
 * the conversation into a new session and answers there (`session.btw`), so
 * it works while the thread's own turn is still running and the thread never
 * sees the question. This module remembers which side threads were asked
 * from which thread, so the desktop and phone can show them beside it with
 * their answer as it streams.
 */
import { defaultLoopHost, type LoopHost } from "../transport.ts";
import { adoptRunningTurn, liveTurnText, notifyThreadChanged, readLiveTurn } from "./liveTurn.ts";

/** One side question, as the thread it was asked from lists it. */
export interface BtwThread {
  /** loop's session id of the side thread. */
  readonly sessionId: string;
  /** loop's session id of the thread it was asked from. */
  readonly sourceSessionId: string;
  readonly question: string;
  readonly askedAt: number;
}

/** The per-turn choices that ride along with a prompt (session.send / session.btw). */
export interface TurnChoices {
  readonly model?: string;
  readonly thinking?: string;
  readonly agent?: string;
}

const BTW = /^\/btw\s+(\S[\s\S]*)$/;

/** True for `/btw <question>` — the composer shows no user row for it, since it never joins this thread. */
export function isBtwPrompt(text: string): boolean {
  return BTW.test(text.trim());
}

/**
 * The question in `/btw <question>`, or null when the text is anything else.
 * A bare `/btw` is refused rather than sent to the model as literal text.
 */
export function btwQuestionOf(text: string): string | null {
  const trimmed = text.trim();
  if (/^\/btw$/.test(trimmed)) throw new Error("/btw needs a question: /btw <question>");
  const match = BTW.exec(trimmed);
  return match ? match[1]!.trim() : null;
}

const asked = new Map<string, BtwThread[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly BtwThread[] = [];

function changed(): void {
  for (const listener of listeners) listener();
}

/** The side threads asked from a thread, oldest first. Stable until the next change. */
export function btwThreadsOf(sourceSessionId: string): readonly BtwThread[] {
  return asked.get(sourceSessionId) ?? EMPTY;
}

/** Notified whenever a side thread is asked or dismissed. Returns an unsubscribe. */
export function onBtwThreadsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stop showing a side thread beside its source. The thread itself stays in loop. */
export function dismissBtwThread(sessionId: string): void {
  for (const [source, threads] of asked) {
    const kept = threads.filter((t) => t.sessionId !== sessionId);
    if (kept.length === threads.length) continue;
    if (kept.length === 0) asked.delete(source);
    else asked.set(source, kept);
    changed();
    return;
  }
}

/** Ask `question` in a side thread of `sourceSessionId`. */
export async function askBtw(
  sourceSessionId: string,
  question: string,
  choices: TurnChoices,
  host: LoopHost = defaultLoopHost,
): Promise<BtwThread> {
  const result = await host.call<{ sessionId?: unknown }>("session.btw", {
    sessionId: sourceSessionId,
    question,
    ...choices,
  });
  if (typeof result?.sessionId !== "string") throw new Error("loop did not report the side thread");
  // The answer is already streaming: adopt the turn so its events (replayed
  // from the host's ring) build a live reply, and announce the new session
  // so the sidebar lists it.
  adoptRunningTurn(result.sessionId, host);
  notifyThreadChanged(result.sessionId);
  const thread: BtwThread = {
    sessionId: result.sessionId,
    sourceSessionId,
    question,
    askedAt: Date.now(),
  };
  asked.set(sourceSessionId, [...btwThreadsOf(sourceSessionId), thread]);
  changed();
  return thread;
}

/** A side thread with its answer as it stands — what a client draws beside the source. */
export interface BtwThreadView {
  readonly thread: BtwThread;
  /** The reply so far ("" before the first word). */
  readonly answer: string;
  readonly running: boolean;
  readonly error?: string;
}

/** Where a side question has got to — one rule; each client chooses how to draw it. */
export type BtwStatus = "thinking" | "answering" | "answered" | "failed";

export function btwStatusOf(view: BtwThreadView): BtwStatus {
  if (view.error) return "failed";
  if (view.running) return view.answer ? "answering" : "thinking";
  return "answered";
}

/** The side threads of a thread, each with its live answer. */
export function btwThreadViews(sourceSessionId: string): BtwThreadView[] {
  return btwThreadsOf(sourceSessionId).map((thread) => {
    const turn = readLiveTurn(thread.sessionId);
    return {
      thread,
      answer: turn ? liveTurnText(turn).trim() : "",
      running: turn?.running === true,
      ...(turn?.error ? { error: turn.error } : {}),
    };
  });
}
