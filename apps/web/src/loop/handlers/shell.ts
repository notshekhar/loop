/**
 * The shell: what the sidebar and the project view are built from.
 *
 * loop has no concept of a "project" — it has sessions, each with a `cwd`. So
 * **the cwd is the project**: sessions are grouped by it, and a project's id is
 * the folder path itself. Nothing is persisted for this; the grouping is
 * derived from `session.list` every time, which means a folder appears the
 * moment it has a session and disappears when its last one is gone.
 *
 * `ProjectId` and `ThreadId` are both `TrimmedNonEmptyString` underneath, so a
 * path and a loop session id are legal ids as-is.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  OrchestrationShellSnapshot as OrchestrationShellSnapshotSchema,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { listUnclaimedProjects, onAddedProjectsChange } from "./addedProjects.ts";
import { clientThreadIdFor } from "./dispatch.ts";
import { onLiveTurnChange } from "./liveTurn.ts";
import { toInstanceId } from "./ids.ts";
import { onSessionWindowChange, pinnedSessionIds, reportSessionPage, sessionScopes } from "./sessionPaging.ts";
import { defaultLoopHost, type LoopHost } from "../transport.ts";
import type { LoopServerInfo } from "./serverConfig.ts";

/** A row of loop's `session.list`; see packages/core/src/sessions/manager.ts. */
export interface LoopSessionRow {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly mtime: number;
  readonly provider: string;
  readonly model: string;
  /** What the session is running on now, when it has moved off the model it
   * was created with. Absent on an older loop. */
  readonly lastModel?: string;
  readonly lastProvider?: string;
  readonly name?: string;
  readonly firstUserMessage?: string;
  readonly running?: boolean;
  readonly attached?: number;
  /** Epoch ms it was archived; absent while it is active. */
  readonly archivedAt?: number;
}

/** A row of loop's `session.projects`: every folder with a session. */
interface LoopSessionFolder {
  readonly cwd: string;
  readonly count: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const decodeSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshotSchema);

/**
 * The working set, paged (sessionPaging.ts): the newest page of the host, of
 * each folder a client is watching, and every session someone has open —
 * plus the whole folder list, which a paged session list cannot derive.
 *
 * `folders` is null when the host predates `session.projects`; such a host
 * also ignores `limit`, so its rows are already the complete list.
 */
async function fetchWorkingSet(
  host: LoopHost,
): Promise<{ rows: LoopSessionRow[]; folders: readonly LoopSessionFolder[] | null }> {
  const scopes = sessionScopes(host.id);
  const pins = pinnedSessionIds(host.id);
  const [pages, pinnedRows, folders] = await Promise.all([
    Promise.all(
      scopes.map((scope) =>
        host
          .call<readonly LoopSessionRow[]>("session.list", {
            limit: scope.limit,
            ...(scope.cwd === null ? {} : { cwd: scope.cwd }),
          })
          .catch(() => [] as readonly LoopSessionRow[]),
      ),
    ),
    pins.length === 0
      ? Promise.resolve([] as readonly LoopSessionRow[])
      : host.call<readonly LoopSessionRow[]>("session.list", { ids: pins }).catch(() => [] as readonly LoopSessionRow[]),
    // Anything but a list (an older host, a stand-in) means "derive them".
    host
      .call<unknown>("session.projects", {})
      .then((value) => (Array.isArray(value) ? (value as readonly LoopSessionFolder[]) : null))
      .catch(() => null),
  ]);
  scopes.forEach((scope, i) => reportSessionPage(host.id, scope.cwd, scope.limit, pages[i]!.length));
  const byId = new Map<string, LoopSessionRow>();
  for (const row of [...pages.flat(), ...pinnedRows]) byId.set(row.id, row);
  return { rows: [...byId.values()], folders };
}

const iso = (epochMs: number) => new Date(epochMs).toISOString();

function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name === "" ? trimmed || "/" : name;
}

/** A thread's title: what the user named it, else what they first asked. */
function threadTitle(row: LoopSessionRow): string {
  const named = row.name?.trim();
  if (named) return named;
  const first = row.firstUserMessage?.trim().replace(/\s+/g, " ");
  if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return "Untitled";
}

/**
 * The shell, for one side of the archive.
 *
 * `archived` is passed through to loop, which defaults to the working set —
 * so the sidebar keeps behaving exactly as before and the Archive settings
 * panel asks for the other side. Filtering client-side instead would mean
 * shipping every archived session to draw a list that excludes them.
 */
export const buildShellSnapshot = Effect.fnUntraced(function* (
  archived = false,
  host: LoopHost = defaultLoopHost,
) {
  // The archive is read whole by its settings panel; the working set pages.
  const [{ rows, folders }, info] = yield* Effect.promise(() =>
    Promise.all([
      archived
        ? host
            .call<readonly LoopSessionRow[]>("session.list", { archived: true })
            .catch(() => [] as readonly LoopSessionRow[])
            .then((all) => ({ rows: [...all], folders: null }))
        : fetchWorkingSet(host),
      host.call<LoopServerInfo>("server.info").catch(() => ({}) as LoopServerInfo),
    ]),
  );
  // A project's default model is loop's own `defaultModel`. loop keeps no
  // per-project model the UI could report, and a null here sent every new
  // thread to the first provider in the list instead of the configured one.
  const projectDefaultModel =
    info.defaults?.model && info.defaults.provider
      ? { instanceId: toInstanceId(info.defaults.provider), model: info.defaults.model }
      : null;

  // One unusable row must not cost the whole sidebar. `ProjectId` is a
  // non-empty string and `projects` is a plain array (not a
  // ForwardCompatibleArray), so a single session whose cwd is "" fails the
  // decode of the entire snapshot and the user sees no projects at all.
  // loop's RPC does not validate cwd on `session.create`, so such rows do
  // reach the store — they are dropped here rather than allowed to blank it.
  const usable = rows.filter((row) => typeof row.cwd === "string" && row.cwd.trim() !== "");

  const projects = new Map<string, { created: number; updated: number }>();
  for (const folder of folders ?? []) {
    if (typeof folder.cwd !== "string" || folder.cwd.trim() === "") continue;
    projects.set(folder.cwd, { created: folder.createdAt, updated: folder.updatedAt });
  }
  for (const row of usable) {
    const existing = projects.get(row.cwd);
    if (existing) {
      existing.created = Math.min(existing.created, row.createdAt);
      existing.updated = Math.max(existing.updated, row.mtime);
    } else {
      projects.set(row.cwd, { created: row.createdAt, updated: row.mtime });
    }
  }

  const newestFirst = [...usable].sort((a, b) => b.mtime - a.mtime);

  // A folder someone just added has no session yet, so nothing above sees it.
  // It is reported until one exists, then the session-derived project takes
  // over under the folder as its id.
  const unclaimed = listUnclaimedProjects(host.id, new Set(projects.keys()));

  return yield* decodeSnapshot({
    // One derived snapshot per read; there is no incremental sequence to
    // resume from, so every subscription starts from zero.
    snapshotSequence: 0,
    projects: [
      ...[...projects].map(([cwd, times]) => ({
        id: cwd,
        title: folderName(cwd),
        workspaceRoot: cwd,
        defaultModelSelection: projectDefaultModel,
        scripts: [],
        createdAt: iso(times.created),
        updatedAt: iso(times.updated),
      })),
      // Reported under the id the palette minted, because that is the id the
      // draft it opened is pointed at.
      ...unclaimed.map((project) => ({
        id: project.id,
        title: folderName(project.folder),
        workspaceRoot: project.folder,
        defaultModelSelection: projectDefaultModel,
        scripts: [],
        createdAt: iso(project.addedAt),
        updatedAt: iso(project.addedAt),
      })),
    ],
    threads: newestFirst.map((row) => ({
      // Reported under the id the client knows, which for a thread it just
      // created is its own draft id rather than loop's session id.
      id: clientThreadIdFor(row.id),
      projectId: row.cwd,
      title: threadTitle(row),
      modelSelection: {
        instanceId: toInstanceId(row.lastProvider || row.provider),
        model: row.lastModel || row.model || "unknown",
      },
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.mtime),
      archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
      // Liveness is loop's own answer, not something inferred here:
      // `session.list` reports `running` per session from the RPC server's
      // active-session table. Reported only while it is true — the merged
      // thread takes its session from the shell (mergeEnvironmentThread), so
      // an always-present session would lock the composer's environment
      // picker on threads that are merely open.
      //
      // It refreshes when a live turn changes, so a turn started outside this
      // client (the TUI on the same loop) stays invisible until the next
      // rebuild.
      session: row.running
        ? {
            threadId: clientThreadIdFor(row.id),
            status: "running",
            providerName: row.lastProvider || row.provider || null,
            activeTurnId: null,
            lastError: null,
            updatedAt: iso(row.mtime),
          }
        : null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    })),
    updatedAt: iso(Date.now()),
  });
});

/**
 * The items a fresh `orchestration.subscribeShell` emits: the snapshot, then
 * the completion marker the client waits on before it will render.
 */
export const initialShellItems = Effect.fnUntraced(function* (host: LoopHost = defaultLoopHost) {
  const snapshot: OrchestrationShellSnapshot = yield* buildShellSnapshot(false, host);
  return [
    { kind: "snapshot" as const, snapshot },
    { kind: "synchronized" as const },
  ] satisfies OrchestrationShellStreamItem[];
});

/** How long to gather changes before rebuilding the shell. */
const SHELL_COALESCE_MS = 120;

/**
 * The shell as a stream.
 *
 * loop has no shell deltas to push, so changes are inferred from turn
 * activity: a turn starting is what creates a session, and a turn ending is
 * what changes its title and timestamp. Rebuilding the whole snapshot is
 * cheap enough (one `session.list`) and cannot drift from a partial update.
 */
export function shellStream(host: LoopHost = defaultLoopHost): Stream.Stream<
  OrchestrationShellStreamItem,
  EnvironmentAuthorizationError
> {
  const failed = () =>
    new EnvironmentAuthorizationError({
      message: "loop could not list its sessions",
      requiredScope: AuthOrchestrationReadScope,
    });

  const initial = initialShellItems(host).pipe(Effect.mapError(failed));

  const updates = Stream.callback<OrchestrationShellStreamItem>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        /**
         * One rebuild at a time — the same guard `threadStream` already has.
         *
         * The timer was cleared BEFORE the async build began, so a rebuild
         * slower than the window (this one lists every session in every
         * project) had the next scheduled while it was still in flight, and
         * the pile grew for as long as changes kept arriving.
         */
        let building = false;
        let pending = false;

        const run = () => {
          building = true;
          void Effect.runPromise(buildShellSnapshot(false, host))
            .then((snapshot) => Queue.offerUnsafe(queue, { kind: "snapshot" as const, snapshot }))
            .catch(() => undefined)
            .finally(() => {
              building = false;
              if (pending) {
                pending = false;
                rebuild();
              }
            });
        };

        const rebuild = () => {
          if (timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            if (building) {
              pending = true;
              return;
            }
            run();
          }, SHELL_COALESCE_MS);
        };

        // Turn activity is not the only thing that changes the shell: adding a
        // folder creates a project before any turn has happened.
        //
        // Lifecycle changes only: a turn starting or ending, a question
        // opening or closing, a session renamed or removed. Neither a delta
        // (MEASURED: ~2600 for one streamed file) nor a tool call changes
        // which sessions exist or how they are listed, and each rebuild costs
        // a re-render of every session row — 200–300ms with a few hundred.
        const unsubscribes = [
          onLiveTurnChange((_sessionId, _structural, lifecycle) => {
            if (lifecycle) rebuild();
          }),
          onAddedProjectsChange(rebuild),
          // The list scrolled for more, a folder view opened, a thread was
          // opened from search: the window changed, so does the shell.
          onSessionWindowChange((hostId) => {
            if (hostId === host.id) rebuild();
          }),
        ];
        return () => {
          if (timer !== null) clearTimeout(timer);
          pending = false;
          for (const unsubscribe of unsubscribes) unsubscribe();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );

  return Stream.fromEffect(initial).pipe(Stream.flattenIterable, Stream.concat(updates));
}
