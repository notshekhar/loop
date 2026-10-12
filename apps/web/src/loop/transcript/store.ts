/**
 * A session's transcript (packages/core/src/transcript) as this client holds
 * it: the host's snapshot plus every live event after it.
 *
 * The order is what makes it exact. Subscribe to the stream first and buffer;
 * then take `session.messages`, which says which event it is good to (`seq`);
 * then apply the buffered and later events past that seq, each once. Nothing
 * here merges saved history with the stream — the host already did that, in
 * one place, with the same rules as the terminal.
 *
 * A host older than the transcript protocol (no `session.messages`) gets the
 * same treatment from its `session.history`, built with the same
 * `fromEntries` the host would have used.
 */
import {
  applyEvent,
  emptyTranscript,
  fromEntries,
  type Transcript,
  type TranscriptEvent,
  type TranscriptTodo,
} from "@loop/transcript";

import type { LoopEvent, LoopHost } from "../transport";

/** What the snapshot says about the session itself. */
export interface TranscriptMeta {
  readonly info?: { readonly cwd?: string; readonly createdAt?: number; readonly provider?: string; readonly model?: string };
  /** The model in force (follows /model switches), and its provider. */
  readonly model?: string;
  readonly provider?: string;
  readonly name?: string;
}

export interface TranscriptView {
  readonly transcript: Transcript;
  /** The snapshot has landed; before that, `transcript` is empty. */
  readonly ready: boolean;
  readonly meta: TranscriptMeta;
}

interface Watched {
  view: TranscriptView;
  seq: number;
  readonly listeners: Set<() => void>;
  host: LoopHost | null;
  stop: (() => void) | null;
}

const watched = new Map<string, Watched>();
const keyOf = (host: LoopHost, sessionId: string) => `${host.id}\u0000${sessionId}`;

const EMPTY: TranscriptView = { transcript: emptyTranscript(), ready: false, meta: {} };

function notify(entry: Watched): void {
  for (const listener of entry.listeners) listener();
}

interface Snapshot extends TranscriptMeta {
  readonly messages?: Transcript["messages"];
  readonly entries?: unknown[];
  readonly todos?: readonly TranscriptTodo[];
  readonly running?: boolean;
  readonly seq?: number;
}

const metaOf = (snapshot: Snapshot): TranscriptMeta => ({
  ...(snapshot.info === undefined ? {} : { info: snapshot.info }),
  ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
  ...(snapshot.provider === undefined ? {} : { provider: snapshot.provider }),
  ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
});

/** The host's transcript of a session and the event seq it is good to. */
export async function snapshotOf(
  host: LoopHost,
  sessionId: string,
): Promise<{ transcript: Transcript; seq: number; meta: TranscriptMeta }> {
  const snapshot = await host
    .call<Snapshot>("session.messages", { sessionId })
    .catch((error: unknown) => {
      if (/method not found/i.test(String((error as Error)?.message ?? error))) return null;
      throw error;
    });
  if (snapshot && Array.isArray(snapshot.messages)) {
    return {
      transcript: { messages: snapshot.messages, todos: [...(snapshot.todos ?? [])], running: snapshot.running === true },
      seq: snapshot.seq ?? 0,
      meta: metaOf(snapshot),
    };
  }
  // A host before protocol 1.2: the same transcript, built here from the
  // branch with the rules the host would have used.
  const history = await host.call<Snapshot>("session.history", { sessionId });
  return {
    transcript: fromEntries((history.entries ?? []) as Parameters<typeof fromEntries>[0], {
      running: history.running === true,
    }),
    seq: history.seq ?? 0,
    meta: metaOf(history),
  };
}

/**
 * Streamed chunks that only grow a block already on screen. Their notify is
 * coalesced (see DELTA_NOTIFY_MS); the view itself is updated at once.
 */
const DELTA_EVENTS: ReadonlySet<string> = new Set(["text-delta", "reasoning-delta", "tool-input-delta"]);
/** At most twenty re-renders a second while a reply streams. */
const DELTA_NOTIFY_MS = 50;

function start(entry: Watched, host: LoopHost, sessionId: string): () => void {
  let stopped = false;
  let buffer: LoopEvent[] | null = [];
  let pendingNotify: ReturnType<typeof setTimeout> | null = null;

  const notifyNow = () => {
    if (pendingNotify !== null) clearTimeout(pendingNotify);
    pendingNotify = null;
    notify(entry);
  };

  const apply = (event: LoopEvent) => {
    // Already in the snapshot, or a replay of what arrived live.
    if (event.seq <= entry.seq) return;
    entry.seq = event.seq;
    entry.view = {
      ...entry.view,
      transcript: applyEvent(entry.view.transcript, event.part as TranscriptEvent),
    };
    if (DELTA_EVENTS.has((event.part as { type?: string }).type ?? "")) {
      pendingNotify ??= setTimeout(notifyNow, DELTA_NOTIFY_MS);
      return;
    }
    notifyNow();
  };

  const offEvent = host.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    // Another process (the terminal) wrote to this session: the host reloaded
    // it, so take a fresh snapshot rather than waiting for a reopen.
    const part = event.part as { type?: string; data?: { change?: unknown } } | undefined;
    if (part?.type === "session-status" && part.data?.change === "updated") {
      void snapshot();
      return;
    }
    if (typeof event.seq !== "number" || event.seq <= 0) return;
    if (buffer) buffer.push(event);
    else apply(event);
  });

  // Only the newest snapshot may land. Two can overlap (the first open and a
  // socket reconnect), and they share one buffer: whichever finished last used
  // to replace the view and could flush a buffer the other had already taken —
  // text showed, then vanished.
  let generation = 0;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const snapshot = async () => {
    const mine = ++generation;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    buffer ??= [];
    try {
      // Subscribed before the snapshot is read, so nothing falls between them.
      await host.call("session.attach", { sessionId }).catch(() => undefined);
      const { transcript, seq, meta } = await snapshotOf(host, sessionId);
      if (stopped || mine !== generation) return;
      failures = 0;
      entry.seq = seq;
      entry.view = { transcript, ready: true, meta };
      const pending = buffer;
      buffer = null;
      for (const event of pending ?? []) apply(event);
      notify(entry);
    } catch {
      if (stopped || mine !== generation) return;
      // A thread already on screen keeps what arrived meanwhile (a hole in a
      // reply is worse than an event the seq check later drops); a first load
      // keeps buffering for the retry. Either way, try again: a remote socket
      // does not reconnect on its own, so waiting for "open" waited forever on
      // "Loading messages…".
      if (entry.view.ready) {
        const pending = buffer;
        buffer = null;
        for (const event of pending ?? []) apply(event);
      }
      failures += 1;
      retryTimer = setTimeout(() => void snapshot(), Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)));
    }
  };

  // A reconnected socket starts over: a fresh snapshot, and the counter it
  // brings (a restarted host numbers its events from 1 again).
  const offConnection = host.onConnectionChange((state) => {
    if (state === "open") void snapshot();
  });
  void snapshot();

  return () => {
    stopped = true;
    if (pendingNotify !== null) clearTimeout(pendingNotify);
    if (retryTimer !== null) clearTimeout(retryTimer);
    offEvent();
    offConnection();
  };
}

/** Watch a session's transcript on `host`. Returns an unsubscribe. */
export function watchTranscript(host: LoopHost, sessionId: string, listener: () => void): () => void {
  const key = keyOf(host, sessionId);
  let entry = watched.get(key);
  if (!entry) {
    entry = { view: EMPTY, seq: 0, listeners: new Set(), host, stop: null };
    watched.set(key, entry);
    entry.stop = start(entry, host, sessionId);
  }
  entry.listeners.add(listener);
  const current = entry;
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    current.stop?.();
    watched.delete(key);
  };
}

/** The transcript as last seen, or an empty, not-ready one. */
export function readTranscript(host: LoopHost, sessionId: string): TranscriptView {
  return watched.get(keyOf(host, sessionId))?.view ?? EMPTY;
}

/** Drop everything held (tests). */
export function forgetTranscriptsForTests(): void {
  for (const entry of watched.values()) entry.stop?.();
  watched.clear();
}
