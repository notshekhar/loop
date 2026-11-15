import { ensureInlineTerminalContextPlaceholders } from "../lib/terminalContext";
import { createEmptyThreadDraft, revokeObjectPreviewUrl, withDraft } from "./draftContent";
import { resolveComposerDraftKey } from "./targets";
import type { ComposerDraftActionBuilder } from "./types";

const setPrompt: ComposerDraftActionBuilder<"setPrompt"> = (set, get) => (threadRef, prompt) => {
  const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
  if (threadKey.length === 0) {
    return;
  }
  set((state) => {
    const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
    return withDraft(state, threadKey, { ...existing, prompt });
  });
};

const clearComposerContent: ComposerDraftActionBuilder<"clearComposerContent"> =
  (set, get) => (threadRef) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) {
        return state;
      }
      return withDraft(state, threadKey, {
        ...current,
        prompt: "",
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        elementContexts: [],
        previewAnnotations: [],
        reviewComments: [],
      });
    });
  };

const clearComposerPromptAndImages: ComposerDraftActionBuilder<"clearComposerPromptAndImages"> =
  (set, get) => (threadRef) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) {
        return state;
      }
      for (const image of current.images) {
        revokeObjectPreviewUrl(image.previewUrl);
      }
      return withDraft(state, threadKey, {
        ...current,
        prompt: ensureInlineTerminalContextPlaceholders("", current.terminalContexts.length),
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
      });
    });
  };

/** Prompt text and the bulk clears that reset a draft after send or stash. */
export const contentActions = {
  setPrompt,
  clearComposerContent,
  clearComposerPromptAndImages,
};
