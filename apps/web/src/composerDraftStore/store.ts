import { create } from "zustand";
import { persist } from "zustand/middleware";
import { attachedContextActions } from "./attachedContextActions";
import { attachmentActions } from "./attachmentActions";
import { contentActions } from "./contentActions";
import { modelActions } from "./modelActions";
import { composerDraftPersistOptions } from "./persistence";
import { sessionActions } from "./sessionActions";
import { sessionQueryActions } from "./sessionQueries";
import { terminalContextActions } from "./terminalContextActions";
import type {
  ComposerDraftActionBuilder,
  ComposerDraftStoreGet,
  ComposerDraftStoreSet,
  ComposerDraftStoreState,
} from "./types";

type ActionKey = {
  [K in keyof ComposerDraftStoreState]: ComposerDraftStoreState[K] extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[keyof ComposerDraftStoreState];

/** Turns a group of action builders into the store's bound actions. */
function bindActions<K extends ActionKey>(
  builders: { [P in K]: ComposerDraftActionBuilder<P> },
  set: ComposerDraftStoreSet,
  get: ComposerDraftStoreGet,
): Pick<ComposerDraftStoreState, K> {
  const actions = {} as Pick<ComposerDraftStoreState, K>;
  for (const key of Object.keys(builders) as K[]) {
    actions[key] = builders[key](set, get);
  }
  return actions;
}

const composerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
      ...bindActions(sessionQueryActions, set, get),
      ...bindActions(sessionActions, set, get),
      ...bindActions(modelActions, set, get),
      ...bindActions(contentActions, set, get),
      ...bindActions(attachmentActions, set, get),
      ...bindActions(terminalContextActions, set, get),
      ...bindActions(attachedContextActions, set, get),
    }),
    composerDraftPersistOptions,
  ),
);

export const useComposerDraftStore = composerDraftStore;
