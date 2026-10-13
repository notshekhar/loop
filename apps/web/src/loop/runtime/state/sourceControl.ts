import { WS_METHODS } from "@loop/contracts";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    // Pull requests through `gh` (contracts/pullRequests.ts).
    pullRequests: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:pull-requests",
      tag: WS_METHODS.loopPullRequestsList,
      staleTimeMs: 60_000,
    }),
    pullRequestDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:pull-request-detail",
      tag: WS_METHODS.loopPullRequestsDetail,
      staleTimeMs: 60_000,
    }),
    pullRequestDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:pull-request-diff",
      tag: WS_METHODS.loopPullRequestsDiff,
      staleTimeMs: 5 * 60_000,
    }),
    pullRequestConversation: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:pull-request-conversation",
      tag: WS_METHODS.loopPullRequestsConversation,
      staleTimeMs: 60_000,
    }),
    // Writes to one PR run one at a time: a merge must not race a review.
    pullRequestAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:pull-request-action",
      tag: WS_METHODS.loopPullRequestsAction,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.cwd}:${input.number}`,
      },
    }),
    githubLoginStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:github-login-start",
      tag: WS_METHODS.loopGithubLoginStart,
    }),
    githubLoginStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:github-login-status",
      tag: WS_METHODS.loopGithubLoginStatus,
    }),
    githubLoginCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:github-login-cancel",
      tag: WS_METHODS.loopGithubLoginCancel,
    }),
    githubLoginWithToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:github-login-token",
      tag: WS_METHODS.loopGithubLoginWithToken,
    }),
    cloneRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:clone-repository",
      tag: WS_METHODS.sourceControlCloneRepository,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}
