/**
 * Git status, refs, diffs — and the actions the buttons trigger.
 *
 * Mostly reads: the panel shows which branch you are on and what has changed,
 * and the agent is what writes code. The exceptions are the things the user
 * does to their own repository by clicking — `init`, and commit/push/PR via
 * `runStackedAction` — which the UI has always offered and which used to fail
 * as "not supported by loop's desktop app".
 *
 * Outside the desktop shell there is no git, so `listRefs` reports "not a repo"
 * — the UI polls it unprompted, and a failure there is a visible retry storm —
 * while the status subscription idles.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  GitActionProgressEvent as GitActionProgressEventSchema,
  GitManagerError,
  ReviewDiffPreviewResult as ReviewDiffPreviewResultSchema,
  VcsListRefsResult as VcsListRefsResultSchema,
  VcsStatusResult as VcsStatusResultSchema,
  VcsUnsupportedOperationError,
  type GitActionProgressEvent,
  type VcsStatusStreamEvent,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  defaultLoopHost,
  type GitStackedAction,
  type GitStackedActionOutcome,
  type GitStatus,
  type LoopHost,
} from "../transport.ts";

const decodeRefs = Schema.decodeUnknownEffect(VcsListRefsResultSchema);
const decodeStatus = Schema.decodeUnknownEffect(VcsStatusResultSchema);
const decodeDiffPreview = Schema.decodeUnknownEffect(ReviewDiffPreviewResultSchema);

/** How often the status panel re-reads git while a project is open. */
const STATUS_POLL_MS = 5_000;

const malformed = (what: string) =>
  new EnvironmentAuthorizationError({
    message: `git returned an unexpected ${what}`,
    requiredScope: AuthOrchestrationReadScope,
  });

/** What a non-repo, or a browser, looks like. */
const NOT_A_REPO = {
  refs: [],
  isRepo: false,
  hasPrimaryRemote: false,
  nextCursor: null,
  totalCount: 0,
};

export const listRefs = Effect.fnUntraced(function* (
  input: {
    readonly cwd: string;
    readonly query?: string | undefined;
    readonly refKind?: "all" | "local" | "remote" | undefined;
    readonly limit?: number | undefined;
  },
  host: LoopHost = defaultLoopHost,
) {
  const git = host.git();
  if (!git) return yield* decodeRefs(NOT_A_REPO).pipe(Effect.mapError(() => malformed("ref list")));

  const result = yield* Effect.promise(() => git.refs(input.cwd));
  const query = input.query?.trim().toLowerCase() ?? "";
  const kind = input.refKind ?? "all";
  const matching = result.refs
    .filter((ref) => (kind === "all" ? true : kind === "remote" ? ref.isRemote : !ref.isRemote))
    .filter((ref) => query === "" || ref.name.toLowerCase().includes(query))
    // The branch you are on, then the default, then the rest alphabetically:
    // the two you are most likely to want are never buried in a long list.
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const limited = input.limit === undefined ? matching : matching.slice(0, input.limit);
  return yield* decodeRefs({
    refs: limited,
    isRepo: result.isRepo,
    hasPrimaryRemote: result.hasPrimaryRemote,
    nextCursor: null,
    totalCount: result.totalCount,
  }).pipe(Effect.mapError(() => malformed("ref list")));
});

const toStatusResult = (status: GitStatus) => ({
  ...status,
  aheadOfDefaultCount: 0,
  pr: null,
});

export const refreshStatus = Effect.fnUntraced(function* (
  input: { readonly cwd: string },
  host: LoopHost = defaultLoopHost,
) {
  const git = host.git();
  if (!git) {
    return yield* decodeStatus({
      ...NOT_A_REPO,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }).pipe(Effect.mapError(() => malformed("status")));
  }
  const status = yield* Effect.promise(() => git.status(input.cwd));
  return yield* decodeStatus(toStatusResult(status)).pipe(
    Effect.mapError(() => malformed("status")),
  );
});

/**
 * The status subscription: a snapshot now, then a poll.
 *
 * git has no change feed worth the complexity here — a filesystem watcher over
 * a whole repo costs more than re-reading `git status` — so this polls, and
 * only emits when something actually differs so the UI does not re-render on a
 * timer.
 */
export function statusStream(
  cwd: string,
  host: LoopHost = defaultLoopHost,
): Stream.Stream<VcsStatusStreamEvent, EnvironmentAuthorizationError> {
  const git = host.git();
  if (!git) return Stream.never;

  return Stream.callback<VcsStatusStreamEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let previous = "";
        let stopped = false;

        const tick = async () => {
          if (stopped) return;
          try {
            const status = await git.status(cwd);
            const encoded = JSON.stringify(status);
            if (encoded !== previous) {
              previous = encoded;
              const local = await Effect.runPromise(decodeStatus(toStatusResult(status)));
              Queue.offerUnsafe(queue, { _tag: "snapshot", local, remote: null });
            }
          } catch {
            // A transient git failure is not worth tearing the panel down for.
          }
          if (!stopped) timer = setTimeout(tick, STATUS_POLL_MS);
        };

        let timer: ReturnType<typeof setTimeout> | undefined;
        void tick();
        return () => {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );
}

/**
 * The review pane's two patches.
 *
 * Upstream answers this from a VCS driver registry inside its own server;
 * loop has neither, so the shell shells out to git and this shapes the answer
 * into the contract. The pane asks for it on every keystroke of the base-ref
 * picker, hence the 5s stale window in `review.ts` — this handler itself does
 * no caching.
 *
 * Not a repo is a normal answer, not an error: the pane renders "no changes"
 * and keeps its tabs, which is what a folder that is not a repository should
 * look like. Only a shell too old to have the bridge fails.
 */
export const diffPreview = Effect.fnUntraced(function* (
  input: {
    readonly cwd: string;
    readonly baseRef?: string | undefined;
    readonly ignoreWhitespace?: boolean | undefined;
    readonly contextLines?: number | undefined;
  },
  host: LoopHost = defaultLoopHost,
) {
  const git = host.git();
  if (!git?.diffPreview) {
    return yield* Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "review.getDiffPreview",
        kind: "git",
        detail: "reviewing a diff needs the loop desktop app",
      }),
    );
  }

  const preview = yield* Effect.promise(() =>
    git.diffPreview!(input.cwd, {
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      ...(input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace }),
      ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
    }),
  );

  return yield* decodeDiffPreview({
    cwd: input.cwd,
    generatedAt: new Date().toISOString(),
    sources: preview.sources,
    // Present only when `cwd` is a folder of repositories; the panel uses it
    // to explain a diff whose paths span several of them.
    ...(preview.workspaceRepositories
      ? { workspaceRepositories: preview.workspaceRepositories }
      : {}),
  }).pipe(
    Effect.mapError(
      () =>
        new VcsUnsupportedOperationError({
          operation: "review.getDiffPreview",
          kind: "git",
          detail: "git returned an unexpected diff preview",
        }),
    ),
  );
});

/**
 * Commit, push, and open a pull request.
 *
 * The shell does the git; this turns its progress into the contract's stream.
 * The two terminal events are added here rather than in the shell because this
 * is the layer that knows how the call ended: `action_finished` carries the
 * result, `action_failed` carries git's own message.
 *
 * The stream stays open until one of those two arrives — the UI's toast is
 * driven by them, so ending early would leave a spinner up forever.
 */
export const runStackedAction = (
  input: {
    readonly actionId: string;
    readonly cwd: string;
    readonly action: GitStackedAction;
    readonly commitMessage?: string | undefined;
    readonly featureBranch?: boolean | undefined;
    readonly filePaths?: readonly string[] | undefined;
  },
  host: LoopHost = defaultLoopHost,
): Stream.Stream<GitActionProgressEvent, GitManagerError> => {
  const git = host.git();
  if (!git?.runStackedAction) {
    return Stream.fail(
      new GitManagerError({
        operation: "git.runStackedAction",
        cwd: input.cwd,
        detail: "committing needs the loop desktop app",
      }),
    );
  }
  const run = git.runStackedAction;
  const base = { actionId: input.actionId, cwd: input.cwd, action: input.action };

  return Stream.callback<GitActionProgressEvent, GitManagerError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let done = false;
        // Subscribed before the call starts, or the first phase of a fast
        // action would land before anyone was listening.
        const unsubscribe = git.onActionProgress?.((event) => {
          if (done) return;
          if (event.actionId !== input.actionId) return;
          const decoded = Schema.decodeUnknownOption(GitActionProgressEventSchema)({
            ...base,
            ...event,
          });
          if (Option.isSome(decoded)) Queue.offerUnsafe(queue, decoded.value);
        });

        void run({
          ...base,
          ...(input.commitMessage === undefined ? {} : { commitMessage: input.commitMessage }),
          ...(input.featureBranch === undefined ? {} : { featureBranch: input.featureBranch }),
          ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
        })
          .then((reply) => {
            if (done) return;
            done = true;
            if (reply.ok) {
              Queue.offerUnsafe(queue, {
                ...base,
                kind: "action_finished",
                result: { ...reply.value, toast: buildToast(reply.value) },
              } as GitActionProgressEvent);
            } else {
              Queue.offerUnsafe(queue, {
                ...base,
                kind: "action_failed",
                phase: null,
                message: reply.error || "git failed",
              } as GitActionProgressEvent);
            }
            Queue.endUnsafe(queue);
          })
          .catch((error: unknown) => {
            if (done) return;
            done = true;
            Queue.offerUnsafe(queue, {
              ...base,
              kind: "action_failed",
              phase: null,
              message: error instanceof Error ? error.message : String(error),
            } as GitActionProgressEvent);
            Queue.endUnsafe(queue);
          });

        return () => {
          done = true;
          unsubscribe?.();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );
};

/**
 * The toast the UI shows when the action lands.
 *
 * Built here because it is presentation, and because the wording has to
 * distinguish "committed nothing because nothing changed" from "never asked to
 * commit" — the outcome statuses carry that and a generic "Done" would not.
 */
function buildToast(result: GitStackedActionOutcome): {
  title: string;
  description?: string;
  cta: { kind: "none" } | { kind: "open_pr"; label: string; url: string };
} {
  if (result.pr.status !== "skipped_not_requested" && result.pr.url) {
    return {
      title: result.pr.status === "created" ? "Pull request created" : "Pull request already open",
      ...(result.pr.title ? { description: result.pr.title } : {}),
      cta: { kind: "open_pr", label: "View pull request", url: result.pr.url },
    };
  }
  if (result.push.status === "pushed") {
    const target = result.push.upstreamBranch ?? result.push.branch;
    return {
      title: "Pushed",
      ...(target ? { description: `Pushed to ${target}.` } : {}),
      cta: { kind: "none" },
    };
  }
  if (result.commit.status === "created") {
    return {
      title: "Committed",
      ...(result.commit.subject ? { description: result.commit.subject } : {}),
      cta: { kind: "none" },
    };
  }
  if (result.commit.status === "skipped_no_changes") {
    return { title: "Nothing to commit", description: "The working tree is clean.", cta: { kind: "none" } };
  }
  if (result.push.status === "skipped_up_to_date") {
    return { title: "Already up to date", description: "Nothing to push.", cta: { kind: "none" } };
  }
  return { title: "Done", cta: { kind: "none" } };
}

/**
 * The settings panel's "Server environment" scan.
 *
 * Reports what tooling is actually installed, so the panel can explain why a
 * button is unavailable instead of the user finding out by clicking it. Options
 * are built here rather than sent over the bridge — the shell speaks plain
 * nulls, the contract wants `Option`, and doing the lift in one place keeps the
 * IPC payload ordinary JSON.
 *
 * A browser has nothing to scan, so it reports an empty environment rather than
 * failing: the panel then says "Nothing detected yet", which is true, instead of
 * showing an error the user cannot act on.
 */
export const discoverSourceControl = Effect.fnUntraced(function* (
  host: LoopHost = defaultLoopHost,
) {
  const git = host.git();
  if (!git?.discover) {
    return { versionControlSystems: [], sourceControlProviders: [] };
  }
  const found = yield* Effect.promise(() => git.discover!());
  return {
    versionControlSystems: found.versionControlSystems.map((vcs) => ({
      kind: vcs.kind,
      implemented: vcs.implemented,
      label: vcs.label,
      executable: vcs.executable,
      status: vcs.status,
      version: Option.fromNullOr(vcs.version),
      installHint: vcs.installHint,
      detail: Option.fromNullOr(vcs.detail),
    })),
    sourceControlProviders: found.sourceControlProviders.map((provider) => ({
      kind: provider.kind,
      label: provider.label,
      executable: provider.executable,
      status: provider.status,
      version: Option.fromNullOr(provider.version),
      installHint: provider.installHint,
      detail: Option.fromNullOr(provider.detail),
      auth: {
        status: provider.auth.status,
        account: Option.fromNullOr(provider.auth.account),
        host: Option.fromNullOr(provider.auth.host),
        detail: Option.fromNullOr(provider.auth.detail),
      },
    })),
  };
});

/**
 * `git init`.
 *
 * A different kind of action from the rest: the folder is not a repo yet, so
 * there is nothing to protect and no agent involved. Without it the
 * "Initialize Git" button failed with `vcs.init is not supported`.
 *
 * Failures come back as the contract's own `VcsUnsupportedOperationError`
 * rather than being swallowed — an init that quietly did nothing would leave
 * the button looking broken in exactly the same way.
 */
export const initRepo = Effect.fnUntraced(function* (
  input: { readonly cwd: string },
  host: LoopHost = defaultLoopHost,
) {
  const git = host.git();
  // A browser has no filesystem to init in, and an older shell has no `init`
  // on its bridge — both are honestly "this surface cannot do that".
  if (!git?.init) {
    return yield* Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "vcs.init",
        kind: "git",
        detail: "initializing a repository needs the loop desktop app",
      }),
    );
  }
  return yield* Effect.tryPromise({
    try: () => git.init!(input.cwd),
    catch: (error) =>
      new VcsUnsupportedOperationError({
        operation: "vcs.init",
        kind: "git",
        detail: error instanceof Error ? error.message : String(error),
      }),
  });
});
