/**
 * Repository-level GitHub work: look up, clone, publish.
 *
 * All three failed as "not supported by loop's desktop app" — publish is the
 * one users hit first, since it is what the "Publish repository" button in the
 * git menu calls. The shell does the `gh` work; this shapes the answer into the
 * contract and turns a failure into the contract's own error so the toast shows
 * gh's message ("name already exists") rather than an IPC wrapper.
 */
import {
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlPublishRepositoryInput,
  type SourceControlRepositoryLookupInput,
} from "@loop/contracts";
import * as Effect from "effect/Effect";

import { defaultLoopHost, type LoopHost } from "../transport.ts";

const unavailable = (operation: string) =>
  new SourceControlRepositoryError({
    provider: "github",
    operation,
    detail: "this needs the loop desktop app",
  });

const failed = (operation: string, detail: string) =>
  new SourceControlRepositoryError({ provider: "github", operation, detail });

export const lookupRepository = Effect.fnUntraced(function* (
  input: SourceControlRepositoryLookupInput,
  host: LoopHost = defaultLoopHost,
) {
  const bridge = host.sourceControl();
  if (!bridge) return yield* Effect.fail(unavailable("lookupRepository"));

  const result = yield* Effect.promise(() => bridge.lookup(input.repository));
  if (!result.ok) return yield* Effect.fail(failed("lookupRepository", result.error));
  if (!result.value) {
    return yield* Effect.fail(failed("lookupRepository", `${input.repository} was not found`));
  }
  // The contract returns the repository itself, not a wrapper around it.
  return result.value;
});

export const cloneRepository = Effect.fnUntraced(function* (
  input: SourceControlCloneRepositoryInput,
  host: LoopHost = defaultLoopHost,
) {
  const bridge = host.sourceControl();
  if (!bridge) return yield* Effect.fail(unavailable("cloneRepository"));

  const result = yield* Effect.promise(() =>
    bridge.clone({
      ...(input.repository === undefined ? {} : { repository: input.repository }),
      ...(input.remoteUrl === undefined ? {} : { remoteUrl: input.remoteUrl }),
      destinationPath: input.destinationPath,
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
    }),
  );
  if (!result.ok) return yield* Effect.fail(failed("cloneRepository", result.error));
  return {
    cwd: result.value.cwd,
    remoteUrl: result.value.remoteUrl,
    repository: result.value.repository,
  };
});

export const publishRepository = Effect.fnUntraced(function* (
  input: SourceControlPublishRepositoryInput,
  host: LoopHost = defaultLoopHost,
) {
  const bridge = host.sourceControl();
  if (!bridge) return yield* Effect.fail(unavailable("publishRepository"));

  const result = yield* Effect.promise(() =>
    bridge.publish({
      cwd: input.cwd,
      repository: input.repository,
      visibility: input.visibility,
      ...(input.remoteName === undefined ? {} : { remoteName: input.remoteName }),
    }),
  );
  if (!result.ok) return yield* Effect.fail(failed("publishRepository", result.error));

  const published = result.value;
  return {
    repository: published.repository,
    remoteName: published.remoteName,
    remoteUrl: published.remoteUrl,
    branch: published.branch,
    // Absent rather than null when there is no upstream yet — a folder with no
    // commits gets a remote but nothing to track against.
    ...(published.upstreamBranch ? { upstreamBranch: published.upstreamBranch } : {}),
    status: published.status,
  };
});
