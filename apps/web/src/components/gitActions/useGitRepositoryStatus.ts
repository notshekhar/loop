import type { ScopedThreadRef } from "@loop/contracts";
import { useEffect, useMemo } from "react";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;

type EnvironmentId = ScopedThreadRef["environmentId"];

type RefreshVcsStatus = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}) => Promise<unknown>;

export function requestVcsStatusRefresh(
  refresh: RefreshVcsStatus,
  environmentId: EnvironmentId | null,
  cwd: string | null,
): void {
  if (environmentId === null || cwd === null) {
    return;
  }
  void refresh({ environmentId, input: { cwd } });
}

/** The repo's VCS status plus what the control derives from it. */
export function useGitRepositoryStatus(
  activeEnvironmentId: EnvironmentId | null,
  gitCwd: string | null,
) {
  const gitStatusQuery = useEnvironmentQuery(
    activeEnvironmentId !== null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: activeEnvironmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const { data: gitStatus, error: gitStatusError } = gitStatusQuery;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  // Default to true while loading so we don't flash init controls.
  //
  // A workspace root counts as NOT a repo here. loop reports one as a repo so
  // the diff surface can span its child repositories, but this control acts on
  // a single repository: the folder has no branch, no remote and nothing to
  // commit into, so every action in the group is inapplicable and `refName:
  // null` was being read as a detached HEAD. What it can actually do is become
  // a repository, which is what the init button offers.
  const isRepo = (gitStatus?.isRepo ?? true) && gitStatus?.isWorkspaceRoot !== true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = useMemo(() => {
    return gitStatus?.isDefaultRef ?? false;
  }, [gitStatus?.isDefaultRef]);
  return {
    gitStatus,
    gitStatusError,
    refreshVcsStatus,
    changeRequestTerminology: sourceControlPresentation.terminology,
    SourceControlIcon: sourceControlPresentation.Icon,
    isRepo,
    hasPrimaryRemote,
    isDefaultRef,
  };
}

/** Refreshes status when the window regains focus or visibility, debounced across both. */
export function useGitStatusRefreshOnFocus(
  refreshVcsStatus: RefreshVcsStatus,
  activeEnvironmentId: EnvironmentId | null,
  gitCwd: string | null,
) {
  useEffect(() => {
    if (gitCwd === null) {
      return;
    }

    let refreshTimeout: number | null = null;
    const scheduleRefreshCurrentGitStatus = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
      }, GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleRefreshCurrentGitStatus();
      }
    };

    window.addEventListener("focus", scheduleRefreshCurrentGitStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("focus", scheduleRefreshCurrentGitStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEnvironmentId, gitCwd, refreshVcsStatus]);
}
