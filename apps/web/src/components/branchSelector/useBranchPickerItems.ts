import { useMemo } from "react";

import { parsePullRequestReference } from "../../pullRequestReference";
import { shouldIncludeBranchPickerItem } from "../BranchToolbar.logic";

interface BranchPickerItemsInput {
  branchNames: ReadonlyArray<string>;
  hasExactBranchMatch: boolean;
  trimmedBranchQuery: string;
  deferredTrimmedBranchQuery: string;
  isSelectingWorktreeBase: boolean;
  canCheckoutPullRequest: boolean;
}

export type BranchPickerItems = ReturnType<typeof useBranchPickerItems>;

/**
 * The combobox values: every listed ref, plus synthetic "checkout PR" and
 * "create ref" entries derived from the search text.
 */
export function useBranchPickerItems({
  branchNames,
  hasExactBranchMatch,
  trimmedBranchQuery,
  deferredTrimmedBranchQuery,
  isSelectingWorktreeBase,
  canCheckoutPullRequest,
}: BranchPickerItemsInput) {
  const normalizedDeferredBranchQuery = deferredTrimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const checkoutPullRequestItemValue =
    prReference && canCheckoutPullRequest ? `__checkout_pull_request__:${prReference}` : null;
  const canCreateBranch = !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const branchPickerItems = useMemo(() => {
    const items = [...branchNames];
    if (createBranchItemValue && !hasExactBranchMatch) {
      items.push(createBranchItemValue);
    }
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  }, [branchNames, checkoutPullRequestItemValue, createBranchItemValue, hasExactBranchMatch]);
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedDeferredBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) =>
            shouldIncludeBranchPickerItem({
              itemValue,
              normalizedQuery: normalizedDeferredBranchQuery,
              createBranchItemValue,
              checkoutPullRequestItemValue,
            }),
          ),
    [
      branchPickerItems,
      checkoutPullRequestItemValue,
      createBranchItemValue,
      normalizedDeferredBranchQuery,
    ],
  );
  return {
    prReference,
    checkoutPullRequestItemValue,
    createBranchItemValue,
    branchPickerItems,
    filteredBranchPickerItems,
  };
}
