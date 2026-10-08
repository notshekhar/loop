import { create } from "zustand";

/**
 * Messages typed while the agent was still working, waiting their turn.
 *
 * loop takes one turn at a time and refuses a second `session.send` outright,
 * so a message sent mid-stream has to be held somewhere until the running turn
 * ends. It is held HERE rather than inside `loop/handlers/dispatch.ts` for one
 * reason: the queue is something the user has to be able to see and take back.
 * A queue nobody can look at is indistinguishable from a message that vanished,
 * which is what this looked like before the strip above the composer existed.
 *
 * The send closure lives on the entry, so cancelling is just removing the row —
 * there is no second structure to keep in step with this one.
 *
 * Deliberately NOT persisted. The closure cannot be serialized, and a message
 * restored after a restart would be sent into a session whose turn ended
 * without anyone watching — long after the user stopped expecting it.
 */
export interface QueuedTurn {
  /** The client's own message id, which is also what the optimistic timeline
   * row is keyed by — that is how the row is kept out of the transcript while
   * the message is still waiting here. */
  readonly id: string;
  /** loop's session id: what the drain is keyed by. */
  readonly sessionId: string;
  /** The client thread id, so the composer can select its own queue. */
  readonly threadId: string;
  /** What to show in the strip. The full outgoing text, contexts and all, is
   * on the closure; this is the part the user actually typed. */
  readonly text: string;
  readonly attachmentCount: number;
  readonly queuedAt: string;
  readonly send: () => Promise<void>;
  /** Stop the turn it is waiting behind, on whichever host the session lives. */
  readonly interrupt: () => Promise<void>;
}

interface QueuedTurnsState {
  /** Oldest first, the order they will be sent in. */
  readonly queue: ReadonlyArray<QueuedTurn>;
  enqueue: (turn: QueuedTurn) => void;
  /** Put one back at the FRONT — a drain that found the turn still running. */
  requeueFirst: (turn: QueuedTurn) => void;
  /** Remove and return the next turn for a session, if any. */
  takeNext: (sessionId: string) => QueuedTurn | undefined;
  /** The user taking a message back. */
  remove: (id: string) => void;
  /** Pull one out by id, to send it right now instead of in turn. */
  take: (id: string) => QueuedTurn | undefined;
  /** Everything waiting on a session — what Stop discards. */
  clearSession: (sessionId: string) => void;
}

export const useQueuedTurnsStore = create<QueuedTurnsState>()((set, get) => ({
  queue: [],
  enqueue: (turn) => set((state) => ({ queue: [...state.queue, turn] })),
  requeueFirst: (turn) => set((state) => ({ queue: [turn, ...state.queue] })),
  takeNext: (sessionId) => {
    const next = get().queue.find((turn) => turn.sessionId === sessionId);
    if (!next) return undefined;
    set((state) => ({ queue: state.queue.filter((turn) => turn.id !== next.id) }));
    return next;
  },
  remove: (id) => set((state) => ({ queue: state.queue.filter((turn) => turn.id !== id) })),
  take: (id) => {
    const found = get().queue.find((turn) => turn.id === id);
    if (!found) return undefined;
    set((state) => ({ queue: state.queue.filter((turn) => turn.id !== id) }));
    return found;
  },
  clearSession: (sessionId) =>
    set((state) => ({ queue: state.queue.filter((turn) => turn.sessionId !== sessionId) })),
}));

export const EMPTY_QUEUE: ReadonlyArray<QueuedTurn> = Object.freeze([]);

/**
 * One thread's queue.
 *
 * Not a zustand selector on purpose: a selector that filters allocates a new
 * array on every store read, and zustand compares the selected value by
 * identity — so every composer would re-render on every unrelated change.
 * Subscribe to `queue` itself (stable until it changes) and narrow with this
 * inside a `useMemo`.
 */
export function queuedTurnsForThread(
  queue: ReadonlyArray<QueuedTurn>,
  threadId: string | null | undefined,
): ReadonlyArray<QueuedTurn> {
  if (!threadId) return EMPTY_QUEUE;
  const matches = queue.filter((turn) => turn.threadId === threadId);
  return matches.length === 0 ? EMPTY_QUEUE : matches;
}
