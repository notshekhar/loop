import type { ProviderInstanceId, ProviderDriverKind } from "@loop/contracts";
import type { ClientSettings } from "@loop/contracts/settings";
import { useCallback, useMemo } from "react";
import type { ModelEsque } from "../providerIconUtils";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../../providerInstances";
import { providerModelKey } from "../../../modelOrdering";
import { flattenModelPickerItems, type LockedProviderMatcher } from "./modelPickerItems";

interface ModelPickerCatalogInput {
  favorites: ClientSettings["favorites"];
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey: string | null | undefined;
}

function useLockedProviderMatcher(
  lockedProvider: ProviderDriverKind | null,
  lockedContinuationGroupKey: string | null | undefined,
): LockedProviderMatcher {
  return useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (lockedProvider === null) return true;
      if (entry.driverKind !== lockedProvider) return false;
      if (!lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === lockedContinuationGroupKey;
    },
    [lockedContinuationGroupKey, lockedProvider],
  );
}

/** Sidebar entries (locked-out instances sorted last) and the set the sidebar greys out. */
function useSidebarInstances(
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  isLocked: boolean,
  matchesLockedProvider: LockedProviderMatcher,
) {
  const lockedDisabledInstanceIds = useMemo(() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const sidebarInstanceEntries = useMemo(() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return enabledEntries;
    }
    const available: ProviderInstanceEntry[] = [];
    const disabled: ProviderInstanceEntry[] = [];
    for (const entry of enabledEntries) {
      if (matchesLockedProvider(entry)) {
        available.push(entry);
      } else {
        disabled.push(entry);
      }
    }
    return [...available, ...disabled];
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  return { lockedDisabledInstanceIds, sidebarInstanceEntries };
}

/** Everything the picker can show: favorites, ready instances and their flattened models. */
export function useModelPickerCatalog(input: ModelPickerCatalogInput) {
  const { favorites, instanceEntries, modelOptionsByInstance } = input;
  // Create a Set for efficient lookup. Favorites are keyed by
  // `${instanceId}:${slug}`; the storage schema widened from ProviderDriverKind
  // to ProviderInstanceId so pre-migration favorites keyed by driver slugs
  // (e.g. `"codex:gpt-5"`) still resolve — the default instance id equals
  // the driver slug.
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  }, [favorites]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  const matchesLockedProvider = useLockedProviderMatcher(
    input.lockedProvider,
    input.lockedContinuationGroupKey,
  );

  const readyInstanceSet = useMemo(() => {
    const ready = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (isProviderInstancePickerReady(entry)) {
        ready.add(entry.instanceId);
      }
    }
    return ready;
  }, [instanceEntries]);

  const flatModels = useMemo(
    () => flattenModelPickerItems(modelOptionsByInstance, entryByInstanceId, readyInstanceSet),
    [modelOptionsByInstance, entryByInstanceId, readyInstanceSet],
  );

  const sidebar = useSidebarInstances(
    instanceEntries,
    input.lockedProvider !== null,
    matchesLockedProvider,
  );
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );
  return {
    favoritesSet,
    entryByInstanceId,
    matchesLockedProvider,
    flatModels,
    instanceOrder,
    ...sidebar,
  };
}
