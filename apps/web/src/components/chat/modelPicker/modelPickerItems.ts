import type { ProviderInstanceId, ProviderDriverKind } from "@loop/contracts";
import { modelPickerLegacySectionKey } from "../modelPickerKeys";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "../modelPickerSearch";
import type { ModelEsque } from "../providerIconUtils";
import type { ProviderInstanceEntry } from "../../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../../modelOrdering";

export type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
};

export type ModelPickerSelection = ProviderInstanceId | "favorites";

export type LockedProviderMatcher = (
  entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
) => boolean;

export interface ModelPickerLegacySection {
  key: string;
  currentModels: ModelPickerItem[];
  legacyModels: ModelPickerItem[];
  isExpanded: boolean;
}

interface RankedModelPickerItem {
  model: ModelPickerItem;
  score: number;
  isFavorite: boolean;
  tieBreaker: string;
}

// Flatten models into a searchable array. One pass over the
// instance-keyed map; each model carries its instance id + driver kind
// so the list row can render the right icon and display name without
// another lookup.
export function flattenModelPickerItems(
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
  entryByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderInstanceEntry>,
  readyInstanceSet: ReadonlySet<ProviderInstanceId>,
): ModelPickerItem[] {
  const out: ModelPickerItem[] = [];
  for (const [instanceId, models] of modelOptionsByInstance) {
    const entry = entryByInstanceId.get(instanceId);
    if (!entry) {
      // Instance disappeared between renders (configuration change). Skip
      // its models — stale options shouldn't appear in the picker.
      continue;
    }
    if (!readyInstanceSet.has(instanceId)) {
      continue;
    }
    for (const model of models) {
      out.push({
        slug: model.slug,
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        ...(model.isLegacy ? { isLegacy: true } : {}),
        instanceId,
        driverKind: entry.driverKind,
        instanceDisplayName: entry.displayName,
        ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
        ...(entry.continuationGroupKey ? { continuationGroupKey: entry.continuationGroupKey } : {}),
      });
    }
  }
  return out;
}

function compareRankedModels(a: RankedModelPickerItem, b: RankedModelPickerItem): number {
  const scoreDelta = a.score - b.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  if (a.isFavorite !== b.isFavorite) {
    return a.isFavorite ? -1 : 1;
  }
  return a.tieBreaker.localeCompare(b.tieBreaker);
}

function rankModel(
  model: ModelPickerItem,
  searchQuery: string,
  favoritesSet: ReadonlySet<string>,
): { model: ModelPickerItem; score: number | null; isFavorite: boolean; tieBreaker: string } {
  return {
    model,
    score: scoreModelPickerSearch(
      {
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driverKind: model.driverKind,
        providerDisplayName: model.instanceDisplayName,
        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
      },
      searchQuery,
    ),
    isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
    tieBreaker: buildModelPickerSearchText({
      name: model.name,
      ...(model.shortName ? { shortName: model.shortName } : {}),
      ...(model.subProvider ? { subProvider: model.subProvider } : {}),
      driverKind: model.driverKind,
      providerDisplayName: model.instanceDisplayName,
    }),
  };
}

/** Apply tokenized fuzzy search across the combined provider/model search fields. */
export function searchModelPickerItems(
  models: ModelPickerItem[],
  searchQuery: string,
  favoritesSet: ReadonlySet<string>,
  lockedProviderMatcher: LockedProviderMatcher | null,
): ModelPickerItem[] {
  const rankedMatches = models
    .map((model) => rankModel(model, searchQuery, favoritesSet))
    .filter((rankedModel): rankedModel is RankedModelPickerItem => rankedModel.score !== null);

  // When searching, we only respect locked provider (by driver kind),
  // ignoring sidebar selection so account-scoped searches can find a
  // model before the user chooses a specific instance rail item.
  if (lockedProviderMatcher !== null) {
    const lockedProviderMatches: RankedModelPickerItem[] = [];
    for (const rankedModel of rankedMatches) {
      if (lockedProviderMatcher(rankedModel.model)) {
        lockedProviderMatches.push(rankedModel);
      }
    }
    return lockedProviderMatches
      .toSorted(compareRankedModels)
      .map((rankedModel) => rankedModel.model);
  }

  return rankedMatches.toSorted(compareRankedModels).map((rankedModel) => rankedModel.model);
}

/** The models shown for one sidebar selection (an instance, or favorites) when not searching. */
export function browseModelPickerItems(
  models: ModelPickerItem[],
  selectedInstanceId: ModelPickerSelection,
  favoritesSet: ReadonlySet<string>,
  instanceOrder: ReadonlyArray<ProviderInstanceId>,
  lockedProviderMatcher: LockedProviderMatcher | null,
): ModelPickerItem[] {
  let result = models;
  if (lockedProviderMatcher !== null) {
    result = result.filter((m) => lockedProviderMatcher(m));
  }
  if (selectedInstanceId === "favorites") {
    result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
  } else {
    result = result.filter((m) => m.instanceId === selectedInstanceId);
  }

  return sortProviderModelItems(result, {
    favoriteModelKeys: favoritesSet,
    groupFavorites: selectedInstanceId !== "favorites",
    instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],
  });
}

export function buildLegacySection(
  filteredModels: ModelPickerItem[],
  selectedInstanceId: ProviderInstanceId,
  expandedLegacyInstances: ReadonlySet<ProviderInstanceId>,
): ModelPickerLegacySection | null {
  const currentModels = filteredModels.filter((model) => !model.isLegacy);
  const legacyModels = filteredModels.filter((model) => model.isLegacy);
  if (legacyModels.length === 0) {
    return null;
  }
  return {
    key: modelPickerLegacySectionKey(selectedInstanceId),
    currentModels,
    legacyModels,
    isExpanded: expandedLegacyInstances.has(selectedInstanceId),
  };
}
