import type { ThreadFeedEntry } from "./threadActivity";

/**
 * Messages you sent that loop has not taken yet, as rows at the end of the
 * thread — so a send shows up the moment you make it, not when the host's
 * transcript next arrives (which, over a phone's connection mid-turn, could be
 * the end of the turn).
 *
 * Two places hold them: the phone's own outbox (waiting for the connection, or
 * for the running turn to end) and the shared dispatch queue (a send that met
 * a turn still running on the host). Both go once loop accepts the message;
 * its real row arrives with the transcript.
 */

export const PENDING_MESSAGE_PREFIX = "queued:";

export interface PendingMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

export function isPendingMessageId(id: string): boolean {
  return id.startsWith(PENDING_MESSAGE_PREFIX);
}

/**
 * The id of the message a row stands for: a pending row is the message you
 * just sent, under the id the composer minted for it.
 */
export function sentMessageIdOf(id: string): string {
  return isPendingMessageId(id) ? id.slice(PENDING_MESSAGE_PREFIX.length) : id;
}

export function appendPendingMessages(
  feed: ReadonlyArray<ThreadFeedEntry>,
  pending: ReadonlyArray<PendingMessage>,
): ThreadFeedEntry[] {
  if (pending.length === 0) return feed as ThreadFeedEntry[];
  const seen = new Set<string>();
  const rows: ThreadFeedEntry[] = [];
  for (const message of pending) {
    // The same message can sit in both queues for a moment during handoff.
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    rows.push({
      type: "message",
      id: `${PENDING_MESSAGE_PREFIX}${message.id}`,
      createdAt: message.createdAt,
      message: {
        id: `${PENDING_MESSAGE_PREFIX}${message.id}`,
        role: "user",
        text: message.text,
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
      } as unknown as Extract<ThreadFeedEntry, { type: "message" }>["message"],
    } as ThreadFeedEntry);
  }
  return [...feed, ...rows];
}
