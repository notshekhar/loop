/**
 * The rows one transcript message folds into, decoded once and then reused.
 *
 * A streaming reply rebuilds the thread every 80ms, and the transcript reducer
 * (`applyEvent`) only ever replaces the message being written — every message
 * above it is the same object as last time. Folding and schema-decoding all of
 * them again handed the timeline thousands of brand-new rows per rebuild, and
 * the timeline then deep-compared each one to find out nothing had changed.
 * MEASURED on a 6,841-entry session: 72ms per rebuild, 67% of a core while a
 * reply streamed. Keyed on the message object, the unchanged ones come back as
 * the very objects already on screen, and only the live message is redone.
 */
import {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
} from "@loop/contracts";
import type { TranscriptMessage } from "@loop/transcript";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** What folding one message produces, before decoding. */
export interface Rows {
  readonly messages: unknown[];
  readonly activities: unknown[];
  readonly plans: unknown[];
}

const DecodedRows = Schema.Struct({
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  plans: Schema.Array(OrchestrationProposedPlan),
});
export type DecodedRows = typeof DecodedRows.Type;

export const decodeRows = Schema.decodeUnknownEffect(DecodedRows);

export const emptyRows = (): Rows => ({ messages: [], activities: [], plans: [] });

/**
 * Where the fold stands between two messages. A message's rows depend on it
 * (its turn and its order stamps), so it is part of what a reuse must match.
 */
export interface FoldPosition {
  readonly turnId: string | null;
  readonly orderMicros: number;
}

interface Memo {
  readonly key: string;
  readonly rows: DecodedRows;
  readonly after: FoldPosition;
}

const memoByMessage = new WeakMap<TranscriptMessage, Memo>();

/**
 * The decoded rows for `message`, reused when it and everything its rows
 * depend on (`key`) are unchanged; a null key is never reused. `fold` produces
 * them otherwise and returns where the fold stands after the message.
 */
export const rowsOf = Effect.fnUntraced(function* (
  message: TranscriptMessage,
  key: string | null,
  fold: () => { readonly rows: Rows; readonly after: FoldPosition },
) {
  const memo = key === null ? undefined : memoByMessage.get(message);
  if (memo !== undefined && memo.key === key) return memo;
  const folded = fold();
  const rows = yield* decodeRows(folded.rows);
  if (key !== null) memoByMessage.set(message, { key, rows, after: folded.after });
  return { rows, after: folded.after };
});
