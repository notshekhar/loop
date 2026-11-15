import type { EnvironmentId, VcsRef } from "@loop/contracts";
import { useDeferredValue, useMemo, useOptimistic } from "react";

import { usePaginatedBranches } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { getSourceControlPresentation } from "../../sourceControlPresentation";
import { resolveBranchToolbarValue } from "../BranchToolbar.logic";

interface BranchRefsInput {
  environmentId: EnvironmentId;
  branchCwd: string | null;
  branchQuery: string;
}

export type BranchRefs = ReturnType<typeof useBranchRefs>;

/** Git status plus the paginated, search-filtered ref list for the picker. */
export function useBranchRefs({ environmentId, branchCwd, branchQuery }: BranchRefsInput) {
  const deferredBranchQuery = useDeferredValue(branchQuery);
  const branchStatusQuery = useEnvironmentQuery(
    branchCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: branchCwd },
        }),
  );
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();
  const branchRefTarget = useMemo(
    () => ({
      environmentId,
      cwd: branchCwd,
      query: deferredTrimmedBranchQuery,
    }),
    [branchCwd, deferredTrimmedBranchQuery, environmentId],
  );
  const branchRefState = usePaginatedBranches(branchRefTarget);
  const refs = branchRefState.refs;
  const hasNextPage =
    branchRefState.data?.nextCursor !== null && branchRefState.data?.nextCursor !== undefined;
  const isFetchingNextPage = branchRefState.isFetchingNextPage;
  const isInitialBranchesLoadPending = branchRefState.isPending && branchRefState.data === null;
  const currentGitBranch =
    branchStatusQuery.data?.refName ?? refs.find((refName) => refName.current)?.name ?? null;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(branchStatusQuery.data?.sourceControlProvider),
    [branchStatusQuery.data?.sourceControlProvider],
  );
  const { branchNames, branchByName, worktreeBaseBranchCandidate } = useRefIndex(
    refs,
    isInitialBranchesLoadPending,
    currentGitBranch,
  );
  const branchStatusText = isInitialBranchesLoadPending
    ? "Loading refs..."
    : isFetchingNextPage
      ? "Loading more refs..."
      : hasNextPage
        ? `Showing ${refs.length} of ${branchRefState.data?.totalCount ?? 0} refs`
        : null;
  return {
    branchStatusQuery,
    branchRefState,
    trimmedBranchQuery,
    deferredTrimmedBranchQuery,
    hasNextPage,
    isFetchingNextPage,
    isInitialBranchesLoadPending,
    currentGitBranch,
    sourceControlPresentation,
    branchNames,
    branchByName,
    worktreeBaseBranchCandidate,
    branchStatusText,
  };
}

function useRefIndex(
  refs: ReadonlyArray<VcsRef>,
  isInitialBranchesLoadPending: boolean,
  currentGitBranch: string | null,
) {
  const branchNames = useMemo(() => refs.map((refName) => refName.name), [refs]);
  const branchByName = useMemo(
    () => new Map(refs.map((refName) => [refName.name, refName] as const)),
    [refs],
  );
  // Default the worktree base to the repo default branch (origin/HEAD), only
  // falling back to the checked-out branch when no default is known.
  const defaultBranchName = useMemo(
    () => refs.find((refName) => refName.isDefault)?.name ?? null,
    [refs],
  );
  const worktreeBaseBranchCandidate = isInitialBranchesLoadPending
    ? null
    : (defaultBranchName ?? currentGitBranch);
  return { branchNames, branchByName, worktreeBaseBranchCandidate };
}

interface ActiveBranchInput {
  environmentId: EnvironmentId;
  branchCwd: string | null;
  effectiveEnvMode: "local" | "worktree";
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
  branchByName: ReadonlyMap<string, VcsRef>;
}

/**
 * The branch the trigger shows, optimistically updated while a switch runs,
 * and whether it is a remote ref (looked up directly when it is not listed).
 */
export function useActiveBranch({
  environmentId,
  branchCwd,
  effectiveEnvMode,
  activeWorktreePath,
  activeThreadBranch,
  currentGitBranch,
  branchByName,
}: ActiveBranchInput) {
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const listedActiveBranch =
    resolvedActiveBranch === null ? null : (branchByName.get(resolvedActiveBranch) ?? null);
  const activeBranchRefQuery = useEnvironmentQuery(
    branchCwd !== null && resolvedActiveBranch !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd: branchCwd,
            query: resolvedActiveBranch,
            limit: 10,
          },
        })
      : null,
  );
  const queriedActiveBranch = activeBranchRefQuery.data?.refs.find(
    (refName) => refName.name === resolvedActiveBranch,
  );
  const resolvedActiveBranchIsRemote =
    listedActiveBranch !== null
      ? listedActiveBranch.isRemote === true
      : queriedActiveBranch
        ? queriedActiveBranch.isRemote === true
        : null;
  return { resolvedActiveBranch, setOptimisticBranch, resolvedActiveBranchIsRemote };
}
