import type { LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { shouldLoadNextBranchPageAfterScroll } from "../../state/paginatedBranches";

interface BranchListScrollInput {
  isBranchMenuOpen: boolean;
  setIsBranchMenuOpen: (open: boolean) => void;
  setBranchQuery: (query: string) => void;
  loadNext: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  deferredTrimmedBranchQuery: string;
  filteredItemCount: number;
}

export type BranchListScroll = ReturnType<typeof useBranchListScroll>;

/** Combobox / list plumbing: open state, edge fades, and paging on scroll. */
export function useBranchListScroll(input: BranchListScrollInput) {
  const { isBranchMenuOpen, setIsBranchMenuOpen, setBranchQuery, deferredTrimmedBranchQuery } =
    input;
  const branchListRef = useRef<LegendListRef | null>(null);
  const branchListScrollElementRef = useRef<HTMLElement | null>(null);
  const previousBranchListScrollTopRef = useRef<number | null>(null);
  const handleOpenChange = useCallback((open: boolean) => {
    previousBranchListScrollTopRef.current = null;
    setIsBranchMenuOpen(open);
    if (!open) {
      setBranchQuery("");
    }
  }, [setBranchQuery, setIsBranchMenuOpen]);

  const maybeFetchNextBranchPage = useNextPageOnScroll(
    input,
    branchListScrollElementRef,
    previousBranchListScrollTopRef,
  );
  const fades = useBranchListScrollFades(input, branchListRef, branchListScrollElementRef);

  useEffect(() => {
    if (!isBranchMenuOpen) {
      return;
    }

    void branchListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
  }, [deferredTrimmedBranchQuery, isBranchMenuOpen]);

  return {
    branchListRef,
    handleOpenChange,
    showTopBranchScrollFade: fades.showTopBranchScrollFade,
    showBottomBranchScrollFade: fades.showBottomBranchScrollFade,
    handleListLayout: () => {
      fades.updateBranchListScrollFades();
      previousBranchListScrollTopRef.current =
        branchListScrollElementRef.current?.scrollTop ?? null;
    },
    handleListScroll: () => {
      fades.updateBranchListScrollFades();
      maybeFetchNextBranchPage();
    },
  };
}

function useNextPageOnScroll(
  { isBranchMenuOpen, loadNext, hasNextPage, isFetchingNextPage }: BranchListScrollInput,
  branchListScrollElementRef: RefObject<HTMLElement | null>,
  previousBranchListScrollTopRef: RefObject<number | null>,
) {
  const fetchNextBranchPage = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) {
      return;
    }

    loadNext();
  }, [loadNext, hasNextPage, isFetchingNextPage]);
  return useCallback(() => {
    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement) {
      return;
    }

    const previousScrollTop = previousBranchListScrollTopRef.current;
    previousBranchListScrollTopRef.current = scrollElement.scrollTop;
    if (
      !isBranchMenuOpen ||
      !hasNextPage ||
      isFetchingNextPage ||
      !shouldLoadNextBranchPageAfterScroll({
        previousScrollTop,
        scrollTop: scrollElement.scrollTop,
        scrollHeight: scrollElement.scrollHeight,
        clientHeight: scrollElement.clientHeight,
      })
    ) {
      return;
    }

    fetchNextBranchPage();
  }, [
    branchListScrollElementRef,
    fetchNextBranchPage,
    hasNextPage,
    isBranchMenuOpen,
    isFetchingNextPage,
    previousBranchListScrollTopRef,
  ]);
}

function useBranchListScrollFades(
  { isBranchMenuOpen, deferredTrimmedBranchQuery, filteredItemCount }: BranchListScrollInput,
  branchListRef: RefObject<LegendListRef | null>,
  branchListScrollElementRef: RefObject<HTMLElement | null>,
) {
  const [showTopBranchScrollFade, setShowTopBranchScrollFade] = useState(false);
  const [showBottomBranchScrollFade, setShowBottomBranchScrollFade] = useState(false);
  const updateBranchListScrollFades = useCallback(() => {
    const scrollElement = branchListRef.current?.getScrollableNode?.();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    branchListScrollElementRef.current = scrollElement;
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopBranchScrollFade(scrollElement.scrollTop > 1);
    setShowBottomBranchScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, [branchListRef, branchListScrollElementRef]);

  useLayoutEffect(() => {
    if (!isBranchMenuOpen) {
      return;
    }

    setShowTopBranchScrollFade(false);
    setShowBottomBranchScrollFade(filteredItemCount > 8);
    let nestedFrame = 0;
    const frame = requestAnimationFrame(() => {
      updateBranchListScrollFades();
      nestedFrame = requestAnimationFrame(updateBranchListScrollFades);
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nestedFrame);
    };
  }, [
    deferredTrimmedBranchQuery,
    filteredItemCount,
    isBranchMenuOpen,
    updateBranchListScrollFades,
  ]);

  return { showTopBranchScrollFade, showBottomBranchScrollFade, updateBranchListScrollFades };
}
