/**
 * Address-bar history for the preview browser, kept per environment so one
 * project's local servers never suggest themselves inside another.
 *
 * Persisted to local storage: a browser that forgets every URL on restart is
 * exactly the gap this closes.
 */
import type { EnvironmentId } from "@loop/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  recordPreviewUrlVisit,
  type PreviewUrlHistoryEntry,
} from "./components/preview/previewUrlHistory";
import { resolveStorage } from "./lib/storage";

interface PreviewUrlHistoryStoreState {
  byEnvironmentId: Record<string, ReadonlyArray<PreviewUrlHistoryEntry>>;
  recordVisit: (
    environmentId: EnvironmentId,
    visit: { readonly url: string; readonly title?: string; readonly at?: number },
  ) => void;
  clearEnvironment: (environmentId: EnvironmentId) => void;
}

const EMPTY_HISTORY: ReadonlyArray<PreviewUrlHistoryEntry> = [];

export const usePreviewUrlHistoryStore = create<PreviewUrlHistoryStoreState>()(
  persist(
    (set) => ({
      byEnvironmentId: {},
      recordVisit: (environmentId, visit) =>
        set((state) => {
          const key = String(environmentId);
          const current = state.byEnvironmentId[key] ?? EMPTY_HISTORY;
          const next = recordPreviewUrlVisit(current, {
            url: visit.url,
            ...(visit.title === undefined ? {} : { title: visit.title }),
            at: visit.at ?? Date.now(),
          });
          if (next === current) return state;
          return { byEnvironmentId: { ...state.byEnvironmentId, [key]: next } };
        }),
      clearEnvironment: (environmentId) =>
        set((state) => {
          const key = String(environmentId);
          if (!(key in state.byEnvironmentId)) return state;
          const { [key]: _removed, ...byEnvironmentId } = state.byEnvironmentId;
          return { byEnvironmentId };
        }),
    }),
    {
      name: "loop:preview-url-history:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byEnvironmentId: state.byEnvironmentId }),
    },
  ),
);

export function selectPreviewUrlHistory(
  byEnvironmentId: Record<string, ReadonlyArray<PreviewUrlHistoryEntry>>,
  environmentId: EnvironmentId | null | undefined,
): ReadonlyArray<PreviewUrlHistoryEntry> {
  if (!environmentId) return EMPTY_HISTORY;
  return byEnvironmentId[String(environmentId)] ?? EMPTY_HISTORY;
}
