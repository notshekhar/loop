/**
 * The pull request queries a screen needs, keyed on the environment and the
 * project folder (`gh` resolves the repository from the folder's remote).
 */
import {
  EnvironmentId,
  type LoopPullRequestInvolvement,
  type LoopPullRequestListState,
} from "@loop/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";

export function usePullRequestList(
  environmentId: string | null,
  cwd: string | null,
  filters: { readonly state: LoopPullRequestListState; readonly involvement: LoopPullRequestInvolvement },
) {
  const atom = useMemo(
    () =>
      environmentId && cwd
        ? sourceControlEnvironment.pullRequests({
            environmentId: EnvironmentId.make(environmentId),
            input: { cwd, state: filters.state, involvement: filters.involvement, limit: 50 },
          })
        : null,
    [cwd, environmentId, filters.involvement, filters.state],
  );
  return useEnvironmentQuery(atom);
}

export function usePullRequestDetail(environmentId: string | null, cwd: string | null, number: number) {
  const atom = useMemo(
    () =>
      environmentId && cwd
        ? sourceControlEnvironment.pullRequestDetail({
            environmentId: EnvironmentId.make(environmentId),
            input: { cwd, number },
          })
        : null,
    [cwd, environmentId, number],
  );
  return useEnvironmentQuery(atom);
}

export function usePullRequestDiff(environmentId: string | null, cwd: string | null, number: number) {
  const atom = useMemo(
    () =>
      environmentId && cwd
        ? sourceControlEnvironment.pullRequestDiff({
            environmentId: EnvironmentId.make(environmentId),
            input: { cwd, number },
          })
        : null,
    [cwd, environmentId, number],
  );
  return useEnvironmentQuery(atom);
}
