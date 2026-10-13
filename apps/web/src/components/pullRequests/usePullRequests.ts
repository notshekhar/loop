/**
 * The pull request queries and actions the page needs, keyed on the
 * environment and the project folder (`gh` resolves the repository from the
 * folder's remote).
 */
import type {
  EnvironmentId,
  LoopPullRequestAction,
  LoopPullRequestInvolvement,
  LoopPullRequestListState,
} from "@loop/contracts";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@loop/runtime/state/runtime";
import { useCallback, useMemo, useState } from "react";

import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export interface PullRequestScope {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export function usePullRequestList(
  scope: PullRequestScope | null,
  filters: { readonly state: LoopPullRequestListState; readonly involvement: LoopPullRequestInvolvement },
) {
  const atom = useMemo(
    () =>
      scope
        ? sourceControlEnvironment.pullRequests({
            environmentId: scope.environmentId,
            input: { cwd: scope.cwd, state: filters.state, involvement: filters.involvement, limit: 100 },
          })
        : null,
    [scope, filters.involvement, filters.state],
  );
  return useEnvironmentQuery(atom);
}

export function usePullRequestDetail(scope: PullRequestScope | null, number: number | null) {
  const atom = useMemo(
    () =>
      scope && number !== null
        ? sourceControlEnvironment.pullRequestDetail({
            environmentId: scope.environmentId,
            input: { cwd: scope.cwd, number },
          })
        : null,
    [scope, number],
  );
  return useEnvironmentQuery(atom);
}

export function usePullRequestConversation(scope: PullRequestScope | null, number: number | null) {
  const atom = useMemo(
    () =>
      scope && number !== null
        ? sourceControlEnvironment.pullRequestConversation({
            environmentId: scope.environmentId,
            input: { cwd: scope.cwd, number },
          })
        : null,
    [scope, number],
  );
  return useEnvironmentQuery(atom);
}

export function usePullRequestDiff(scope: PullRequestScope | null, number: number | null) {
  const atom = useMemo(
    () =>
      scope && number !== null
        ? sourceControlEnvironment.pullRequestDiff({
            environmentId: scope.environmentId,
            input: { cwd: scope.cwd, number },
          })
        : null,
    [scope, number],
  );
  return useEnvironmentQuery(atom);
}

const DONE_TITLE: Partial<Record<LoopPullRequestAction["kind"], string>> = {
  comment: "Comment posted",
  review: "Review submitted",
  reply: "Reply posted",
  line_comment: "Comment posted",
  merge: "Pull request merged",
  close: "Pull request closed",
  reopen: "Pull request reopened",
  ready: "Marked ready for review",
  draft: "Converted to draft",
};

/**
 * Run one action on a PR. Failures become a toast with `gh`'s own words;
 * success refreshes whatever the caller says the action changed.
 */
export function usePullRequestAction(scope: PullRequestScope | null, number: number | null) {
  const run = useAtomCommand(sourceControlEnvironment.pullRequestAction, { reportFailure: false });
  const [pending, setPending] = useState<LoopPullRequestAction["kind"] | null>(null);
  const perform = useCallback(
    async (action: LoopPullRequestAction, after?: () => void): Promise<boolean> => {
      if (!scope || number === null) return false;
      setPending(action.kind);
      const result = await run({
        environmentId: scope.environmentId,
        input: { cwd: scope.cwd, number, action },
      });
      setPending(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "GitHub said no",
            description: error instanceof Error ? error.message : String(error),
          });
        }
        return false;
      }
      const title = DONE_TITLE[action.kind];
      if (title) toastManager.add({ type: "success", title });
      after?.();
      return true;
    },
    [number, run, scope],
  );
  return { perform, pending };
}

/** Open a link in the system browser; a plain browser tab outside the desktop shell. */
export function openExternalUrl(url: string | null | undefined): void {
  if (!url) return;
  const api = readLocalApi();
  if (api) {
    void api.shell.openExternal(url).catch(() => window.open(url, "_blank", "noopener"));
    return;
  }
  window.open(url, "_blank", "noopener");
}
