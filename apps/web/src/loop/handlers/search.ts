/**
 * Thread search.
 *
 * loop has no search RPC, and reading every transcript to build one is not an
 * option — a few hundred sessions would each need a `session.history` round
 * trip before the first result appeared.
 *
 * But `session.list` already carries the two fields people actually search by:
 * what the session is called, and what they opened it with. That is one call,
 * already warm, and it answers the common lookup ("where was the thing about
 * the flaky test") immediately. Message-body search would need loop to grow a
 * real index; this does not pretend to be that — it searches titles and
 * opening messages, and says so.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  OrchestrationSearchThreadsResult as OrchestrationSearchThreadsResultSchema,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { clientThreadIdFor } from "./dispatch.ts";
import { setSearchPins } from "./sessionPaging.ts";
import type { LoopSessionRow } from "./shell.ts";
import { defaultLoopHost, type LoopHost } from "../transport.ts";

/** The contract caps a snippet at 240 characters. */
const SNIPPET_MAX = 240;
/** Characters of lead-in kept before the match, so it reads in context. */
const SNIPPET_LEAD = 60;
const DEFAULT_LIMIT = 20;

export interface ThreadSearchMatch {
  readonly threadId: string;
  readonly projectId: string;
  readonly source: "user" | "assistant";
  readonly snippet: string;
  readonly messageCreatedAt: string | null;
}

/**
 * A window of `text` around the hit, trimmed to the contract's limit.
 *
 * Centring on the match matters: a title search that always showed the first
 * 240 characters of a long opening message would not show the word searched
 * for.
 */
export function buildSnippet(text: string, at: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  const start = Math.max(0, Math.min(at - SNIPPET_LEAD, flat.length - SNIPPET_MAX));
  const slice = flat.slice(start, start + SNIPPET_MAX);
  return start > 0 ? `…${slice.slice(1)}` : slice;
}

/** Pure half, so the matching rules are testable without a bridge. */
export function matchSessions(
  rows: readonly LoopSessionRow[],
  query: string,
  limit: number,
): ThreadSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const matches: ThreadSearchMatch[] = [];
  // Newest first, so a capped result set is the recent one.
  for (const row of [...rows].sort((left, right) => right.mtime - left.mtime)) {
    if (matches.length >= limit) break;
    if (typeof row.cwd !== "string" || row.cwd.trim() === "") continue;
    // The name is what the user called it; the first message is what they
    // opened with. Whichever hits first is the snippet.
    for (const text of [row.name, row.firstUserMessage]) {
      if (typeof text !== "string" || text === "") continue;
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      matches.push({
        threadId: clientThreadIdFor(row.id),
        projectId: row.cwd,
        source: "user",
        snippet: buildSnippet(text, at),
        messageCreatedAt: new Date(row.createdAt).toISOString(),
      });
      break;
    }
  }
  return matches;
}

const decodeResult = Schema.decodeUnknownEffect(OrchestrationSearchThreadsResultSchema);

export const searchThreads = Effect.fnUntraced(function* (
  input: {
    readonly query: string;
    readonly limit?: number | undefined;
  },
  host: LoopHost = defaultLoopHost,
) {
  const rows = yield* Effect.promise(() =>
    host.call<readonly LoopSessionRow[]>("session.list").catch(
      () => [] as readonly LoopSessionRow[],
    ),
  );
  const matches = matchSessions(rows, input.query, input.limit ?? DEFAULT_LIMIT);
  // The shell lists a page of sessions; a match older than that page would be
  // found here and then filtered out of a list that does not hold it.
  const matched = new Set(matches.map((match) => match.threadId));
  setSearchPins(
    host.id,
    rows.filter((row) => matched.has(clientThreadIdFor(row.id))).map((row) => row.id),
  );
  // Decoded rather than hand-built: `ThreadId` and `ProjectId` are branded, and
  // the schema is the only thing that can mint them.
  return yield* decodeResult({ matches }).pipe(
    Effect.mapError(
      () =>
        new EnvironmentAuthorizationError({
          message: "loop returned a session it could not describe",
          requiredScope: AuthOrchestrationReadScope,
        }),
    ),
  );
});
