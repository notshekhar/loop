/**
 * Pull requests: the list, one in detail, and its diff — read by the shell
 * through `gh` (core workspace/pullRequests.ts), shaped into the contract
 * here. A shell without the bridge (an older desktop, a browser with no
 * workspace) answers with the contract's own error rather than a crash.
 */
import {
  LoopPullRequestError,
  type LoopPullRequestListInput,
  type LoopPullRequestRefInput,
} from "@loop/contracts";
import * as Effect from "effect/Effect";

import { defaultLoopHost, type LoopHost } from "../transport.ts";

const unavailable = (operation: string) =>
  new LoopPullRequestError({
    operation,
    detail: "Pull requests need a newer loop on this machine — update it with `loop update`.",
  });

const failed = (operation: string, detail: string) => new LoopPullRequestError({ operation, detail });

export const listPullRequests = Effect.fnUntraced(function* (
  input: LoopPullRequestListInput,
  host: LoopHost = defaultLoopHost,
) {
  const bridge = host.sourceControl();
  if (!bridge?.listPullRequests) return yield* Effect.fail(unavailable("list"));
  const result = yield* Effect.promise(() =>
    bridge.listPullRequests!({
      cwd: input.cwd,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.involvement === undefined ? {} : { involvement: input.involvement }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  );
  if (!result.ok) return yield* Effect.fail(failed("list", result.error));
  return result.value;
});

export const pullRequestDetail = Effect.fnUntraced(function* (
  input: LoopPullRequestRefInput,
  host: LoopHost = defaultLoopHost,
) {
  const bridge = host.sourceControl();
  if (!bridge?.pullRequestDetail) return yield* Effect.fail(unavailable("detail"));
  const result = yield* Effect.promise(() => bridge.pullRequestDetail!(input.cwd, input.number));
  if (!result.ok) return yield* Effect.fail(failed("detail", result.error));
  return result.value;
});

export const pullRequestDiff = Effect.fnUntraced(function* (
  input: LoopPullRequestRefInput,
  host: LoopHost = defaultLoopHost,
) {
  const bridge = host.sourceControl();
  if (!bridge?.pullRequestDiff) return yield* Effect.fail(unavailable("diff"));
  const result = yield* Effect.promise(() => bridge.pullRequestDiff!(input.cwd, input.number));
  if (!result.ok) return yield* Effect.fail(failed("diff", result.error));
  return result.value;
});
