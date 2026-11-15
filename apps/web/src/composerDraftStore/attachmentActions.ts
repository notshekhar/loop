import { getLocalStorageItem } from "../hooks/useLocalStorage";
import {
  composerImageDedupKey,
  createEmptyThreadDraft,
  revokeObjectPreviewUrl,
  withDraft,
} from "./draftContent";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  DraftId,
  type PersistedComposerImageAttachment,
  PersistedComposerDraftStoreStorage,
} from "./schema";
import { composerDebouncedStorage } from "./storage";
import { resolveComposerDraftKey, resolveComposerThreadId } from "./targets";
import type {
  ComposerDraftActionBuilder,
  ComposerDraftStoreSet,
  ComposerImageAttachment,
  ComposerThreadDraftState,
} from "./types";

function readPersistedAttachmentIdsFromStorage(threadKey: string): string[] {
  if (threadKey.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByThreadKey[threadKey]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

function verifyPersistedAttachments(
  threadKey: string,
  attachments: PersistedComposerImageAttachment[],
  set: ComposerDraftStoreSet,
): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadKey));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByThreadKey[threadKey];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds: string[] = [];
    for (const image of current.images) {
      if (!persistedIdSet.has(image.id)) {
        nonPersistedImageIds.push(image.id);
      }
    }
    return withDraft(state, threadKey, {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    });
  });
}

/** Drops images already in the draft (by id or content), revoking their now-unused blob URLs. */
function dedupeIncomingImages(
  existing: ComposerThreadDraftState,
  images: ComposerImageAttachment[],
): ComposerImageAttachment[] {
  const existingIds = new Set(existing.images.map((image) => image.id));
  const existingDedupKeys = new Set(existing.images.map((image) => composerImageDedupKey(image)));
  const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
  const dedupedIncoming: ComposerImageAttachment[] = [];
  for (const image of images) {
    const dedupKey = composerImageDedupKey(image);
    if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
      // Avoid revoking a blob URL that's still referenced by an accepted image.
      if (!acceptedPreviewUrls.has(image.previewUrl)) {
        revokeObjectPreviewUrl(image.previewUrl);
      }
      continue;
    }
    dedupedIncoming.push(image);
    existingIds.add(image.id);
    existingDedupKeys.add(dedupKey);
    acceptedPreviewUrls.add(image.previewUrl);
  }
  return dedupedIncoming;
}

const addImage: ComposerDraftActionBuilder<"addImage"> = (_set, get) => (threadRef, image) => {
  const threadKey = resolveComposerDraftKey(get(), threadRef);
  const threadId = resolveComposerThreadId(get(), threadRef);
  if (!threadKey || !threadId) {
    return;
  }
  get().addImages(typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef, [image]);
};

const addImages: ComposerDraftActionBuilder<"addImages"> = (set, get) => (threadRef, images) => {
  const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
  if (threadKey.length === 0 || images.length === 0) {
    return;
  }
  set((state) => {
    const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
    const dedupedIncoming = dedupeIncomingImages(existing, images);
    if (dedupedIncoming.length === 0) {
      return state;
    }
    return {
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [threadKey]: {
          ...existing,
          images: [...existing.images, ...dedupedIncoming],
        },
      },
    };
  });
};

const removeImage: ComposerDraftActionBuilder<"removeImage"> =
  (set, get) => (threadRef, imageId) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    const existing = get().draftsByThreadKey[threadKey];
    if (!existing) {
      return;
    }
    const removedImage = existing.images.find((image) => image.id === imageId);
    if (removedImage) {
      revokeObjectPreviewUrl(removedImage.previewUrl);
    }
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) {
        return state;
      }
      return withDraft(state, threadKey, {
        ...current,
        images: current.images.filter((image) => image.id !== imageId),
        nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
        persistedAttachments: current.persistedAttachments.filter(
          (attachment) => attachment.id !== imageId,
        ),
      });
    });
  };

const clearPersistedAttachments: ComposerDraftActionBuilder<"clearPersistedAttachments"> =
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
        persistedAttachments: [],
        nonPersistedImageIds: [],
      });
    });
  };

const syncPersistedAttachments: ComposerDraftActionBuilder<"syncPersistedAttachments"> =
  (set, get) => (threadRef, attachments) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey) {
      return;
    }
    const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) {
        return state;
      }
      return withDraft(state, threadKey, {
        ...current,
        // Stage attempted attachments so persist middleware can try writing them.
        persistedAttachments: attachments,
        nonPersistedImageIds: current.nonPersistedImageIds.filter(
          (id) => !attachmentIdSet.has(id),
        ),
      });
    });
    Promise.resolve().then(() => {
      verifyPersistedAttachments(threadKey, attachments, set);
    });
  };

/** Staged image/file attachments and their localStorage persistence check. */
export const attachmentActions = {
  addImage,
  addImages,
  removeImage,
  clearPersistedAttachments,
  syncPersistedAttachments,
};
