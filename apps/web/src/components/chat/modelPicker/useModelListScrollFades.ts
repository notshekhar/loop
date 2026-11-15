import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

/** Top/bottom fade flags for the model list, re-measured on scroll, layout and item changes. */
export function useModelListScrollFades(
  modelListRef: RefObject<LegendListRef | null>,
  filteredItemKeys: ReadonlyArray<string>,
) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const updateModelListScrollFades = useCallback(() => {
    const scrollElement = modelListRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(filteredItemKeys.length > 5);
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      updateModelListScrollFades();
      nestedFrame = window.requestAnimationFrame(updateModelListScrollFades);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [filteredItemKeys, updateModelListScrollFades]);

  return { showTopScrollFade, showBottomScrollFade, updateModelListScrollFades };
}
