import type { ProviderInstanceId, ProviderDriverKind } from "@loop/contracts";
import { type RefObject, useCallback, useLayoutEffect, useState } from "react";
import type { ModelPickerSelection } from "./modelPickerItems";

/**
 * The sidebar's selected instance (or favorites), and keeping the search box
 * focused when the picker opens and whenever the selection changes.
 */
export function useModelPickerSelection(input: {
  searchInputRef: RefObject<HTMLInputElement | null>;
  lockedProvider: ProviderDriverKind | null;
  activeInstanceId: ProviderInstanceId;
  hasFavorites: boolean;
}) {
  const { searchInputRef } = input;
  const [selectedInstanceId, setSelectedInstanceId] = useState<ModelPickerSelection>(() => {
    if (input.lockedProvider !== null) {
      // When locked, prime the sidebar to the currently-active instance
      // so jumping into the picker keeps the focused instance visible.
      return input.activeInstanceId;
    }
    return input.hasFavorites ? "favorites" : input.activeInstanceId;
  });

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectInstance = useCallback(
    (instanceId: ModelPickerSelection) => {
      setSelectedInstanceId(instanceId);
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput],
  );

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  return { selectedInstanceId, handleSelectInstance };
}
