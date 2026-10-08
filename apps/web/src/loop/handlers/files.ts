/**
 * File listing, reading and browsing.
 *
 * These are the only handlers whose availability depends on the shell. loop's
 * RPC has no file operations and a browser has no filesystem, so the desktop
 * shell answers them over its preload bridge and `loop serve` cannot. When the
 * bridge is absent they fail loudly with a reason, rather than returning an
 * empty directory that would read as "your project has no files".
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  FilesystemBrowseResult as FilesystemBrowseResultSchema,
  ProjectListEntriesResult as ProjectListEntriesResultSchema,
  ProjectReadFileResult as ProjectReadFileResultSchema,
  ProjectSearchEntriesResult as ProjectSearchEntriesResultSchema,
  ProjectWriteFileResult as ProjectWriteFileResultSchema,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type WorkspaceEntry, defaultLoopHost, type LoopHost } from "../transport.ts";

const decodeEntries = Schema.decodeUnknownEffect(ProjectListEntriesResultSchema);
const decodeSearch = Schema.decodeUnknownEffect(ProjectSearchEntriesResultSchema);
const decodeRead = Schema.decodeUnknownEffect(ProjectReadFileResultSchema);
const decodeBrowse = Schema.decodeUnknownEffect(FilesystemBrowseResultSchema);
const decodeWrite = Schema.decodeUnknownEffect(ProjectWriteFileResultSchema);

const unavailable = (what: string) =>
  new EnvironmentAuthorizationError({
    message: `${what} needs loop's desktop app; the browser build has no filesystem`,
    requiredScope: AuthOrchestrationReadScope,
  });

const failed = (what: string, detail: string) =>
  new EnvironmentAuthorizationError({
    message: `${what} failed: ${detail}`,
    requiredScope: AuthOrchestrationReadScope,
  });

/** `ProjectEntry.path` is a non-empty string, so the root itself is dropped. */
const usable = (entry: WorkspaceEntry) => entry.path.trim() !== "";

export const listEntries = Effect.fnUntraced(function* (
  cwd: string,
  host: LoopHost = defaultLoopHost,
) {
  const files = host.filesystem();
  if (!files) return yield* Effect.fail(unavailable("Listing project files"));
  const result = yield* Effect.promise(() => files.list(cwd));
  return yield* decodeEntries({
    entries: result.entries.filter(usable),
    truncated: result.truncated,
  }).pipe(Effect.mapError(() => failed("Listing project files", "unexpected entry shape")));
});

/**
 * Search is the same listing, ranked here.
 *
 * The picker asks for a query and a limit; there is no index to consult, so
 * matching is a subsequence test over the path — the behaviour people expect
 * from a fuzzy file picker — with shorter paths winning ties because they are
 * closer to the root and more likely to be what was meant.
 */
export const searchEntries = Effect.fnUntraced(function* (
  input: {
    readonly cwd: string;
    readonly query: string;
    readonly limit: number;
    readonly kind?: "file" | "directory" | undefined;
  },
  host: LoopHost = defaultLoopHost,
) {
  const files = host.filesystem();
  if (!files) return yield* Effect.fail(unavailable("Searching project files"));
  const result = yield* Effect.promise(() => files.list(input.cwd));

  const query = input.query.trim().toLowerCase();
  const candidates = result.entries
    .filter(usable)
    .filter((entry) => input.kind === undefined || entry.kind === input.kind)
    .filter((entry) => query === "" || isSubsequence(query, entry.path.toLowerCase()))
    .sort((a, b) => a.path.length - b.path.length)
    .slice(0, input.limit);

  return yield* decodeSearch({
    entries: candidates,
    truncated: result.truncated || candidates.length === input.limit,
  }).pipe(Effect.mapError(() => failed("Searching project files", "unexpected entry shape")));
});

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

export const readFile = Effect.fnUntraced(function* (
  input: {
    readonly cwd: string;
    readonly relativePath: string;
  },
  host: LoopHost = defaultLoopHost,
) {
  const files = host.filesystem();
  if (!files) return yield* Effect.fail(unavailable("Reading a file"));
  const result = yield* Effect.promise(() => files.read(input.cwd, input.relativePath));
  if (!result.ok) return yield* Effect.fail(failed("Reading a file", result.failure));
  return yield* decodeRead(result).pipe(
    Effect.mapError(() => failed("Reading a file", "unexpected result shape")),
  );
});

/**
 * Save an edited file.
 *
 * The editor's save loop treats anything but a success as "still unsaved", so
 * this failing is not cosmetic: it leaves the tab's dot on forever. It was
 * failing for the most basic reason — the shell had no write at all and the
 * handler was a stub — which is why saving never worked.
 *
 * The shell answers with the path it actually wrote, which can differ from the
 * one asked for when the request repeated the tail of the workspace root. The
 * caller keys its cache by that path, so the resolved one is what comes back.
 */
export const writeFile = Effect.fnUntraced(function* (
  input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly contents: string;
  },
  host: LoopHost = defaultLoopHost,
) {
  const files = host.filesystem();
  if (!files) return yield* Effect.fail(unavailable("Saving a file"));
  if (!files.write) return yield* Effect.fail(unavailable("Saving a file"));
  const result = yield* Effect.promise(() =>
    files.write!(input.cwd, input.relativePath, input.contents),
  );
  if (!result.ok) return yield* Effect.fail(failed("Saving a file", result.failure));
  return yield* decodeWrite({ relativePath: result.relativePath }).pipe(
    Effect.mapError(() => failed("Saving a file", "unexpected result shape")),
  );
});

export const browse = Effect.fnUntraced(function* (
  input: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
  },
  host: LoopHost = defaultLoopHost,
) {
  const files = host.filesystem();
  if (!files) return yield* Effect.fail(unavailable("Browsing folders"));
  const result = yield* Effect.promise(() => files.browse(input.partialPath, input.cwd));
  if (!result) return yield* Effect.fail(failed("Browsing folders", "read_directory_failed"));
  return yield* decodeBrowse(result).pipe(
    Effect.mapError(() => failed("Browsing folders", "unexpected result shape")),
  );
});
