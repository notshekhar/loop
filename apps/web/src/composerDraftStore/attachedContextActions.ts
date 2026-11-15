import type { PreviewAnnotationPayload } from "@loop/contracts";
import {
  type ElementContextDraft,
  elementContextDedupKey,
  newElementContextId,
} from "../lib/elementContext";
import { createEmptyThreadDraft, withDraft } from "./draftContent";
import { isReviewCommentContext } from "./schema";
import { resolveComposerDraftKey, resolveComposerThreadId } from "./targets";
import type { ComposerDraftActionBuilder } from "./types";

const addElementContext: ComposerDraftActionBuilder<"addElementContext"> =
  (set, get) => (threadRef, selection) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    const threadId = resolveComposerThreadId(get(), threadRef);
    if (!threadKey || !threadId) return false;
    let accepted = false;
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      const dedupKey = elementContextDedupKey(selection);
      if (existing.elementContexts.some((entry) => elementContextDedupKey(entry) === dedupKey)) {
        return state;
      }
      accepted = true;
      const draft: ElementContextDraft = {
        ...selection,
        id: newElementContextId(),
        threadId,
        pickedAt: new Date().toISOString(),
      };
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [threadKey]: {
            ...existing,
            elementContexts: [...existing.elementContexts, draft],
          },
        },
      };
    });
    return accepted;
  };

const setElementContexts: ComposerDraftActionBuilder<"setElementContexts"> =
  (set, get) => (threadRef, contexts) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey) return;
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      return withDraft(state, threadKey, { ...existing, elementContexts: [...contexts] });
    });
  };

const removeElementContext: ComposerDraftActionBuilder<"removeElementContext"> =
  (set, get) => (threadRef, contextId) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0 || contextId.length === 0) return;
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) return state;
      const filtered = current.elementContexts.filter((entry) => entry.id !== contextId);
      if (filtered.length === current.elementContexts.length) return state;
      return withDraft(state, threadKey, { ...current, elementContexts: filtered });
    });
  };

const clearElementContexts: ComposerDraftActionBuilder<"clearElementContexts"> =
  (set, get) => (threadRef) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) return;
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current || current.elementContexts.length === 0) return state;
      return withDraft(state, threadKey, { ...current, elementContexts: [] });
    });
  };

const addPreviewAnnotation: ComposerDraftActionBuilder<"addPreviewAnnotation"> =
  (set, get) => (threadRef, annotation) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey) return;
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      const nextAnnotations = existing.previewAnnotations.filter(
        (entry) => entry.id !== annotation.id,
      );
      const compactAnnotation: PreviewAnnotationPayload = {
        ...annotation,
        screenshot: annotation.screenshot ? { ...annotation.screenshot, dataUrl: "" } : null,
      };
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [threadKey]: {
            ...existing,
            previewAnnotations: [...nextAnnotations, compactAnnotation],
          },
        },
      };
    });
  };

const setPreviewAnnotations: ComposerDraftActionBuilder<"setPreviewAnnotations"> =
  (set, get) => (threadRef, annotations) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey) return;
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [threadKey]: { ...existing, previewAnnotations: [...annotations] },
        },
      };
    });
  };

const removePreviewAnnotation: ComposerDraftActionBuilder<"removePreviewAnnotation"> =
  (set, get) => (threadRef, annotationId) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey || !annotationId) return;
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) return state;
      const previewAnnotations = current.previewAnnotations.filter(
        (entry) => entry.id !== annotationId,
      );
      if (previewAnnotations.length === current.previewAnnotations.length) return state;
      return withDraft(state, threadKey, {
        ...current,
        previewAnnotations,
        images: current.images.filter((image) => image.id !== annotationId),
        persistedAttachments: current.persistedAttachments.filter(
          (image) => image.id !== annotationId,
        ),
        nonPersistedImageIds: current.nonPersistedImageIds.filter(
          (imageId) => imageId !== annotationId,
        ),
      });
    });
  };

const addReviewComment: ComposerDraftActionBuilder<"addReviewComment"> =
  (set, get) => (threadRef, comment) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey || !isReviewCommentContext(comment)) return;
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      const reviewComments = existing.reviewComments.filter((entry) => entry.id !== comment.id);
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [threadKey]: {
            ...existing,
            reviewComments: [...reviewComments, { ...comment }],
          },
        },
      };
    });
  };

const setReviewComments: ComposerDraftActionBuilder<"setReviewComments"> =
  (set, get) => (threadRef, comments) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey) return;
    const reviewComments = comments
      .filter(isReviewCommentContext)
      .map((comment) => ({ ...comment }));
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      return withDraft(state, threadKey, { ...existing, reviewComments });
    });
  };

const removeReviewComment: ComposerDraftActionBuilder<"removeReviewComment"> =
  (set, get) => (threadRef, commentId) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    if (!threadKey || !commentId) return;
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) return state;
      const reviewComments = current.reviewComments.filter((entry) => entry.id !== commentId);
      if (reviewComments.length === current.reviewComments.length) return state;
      return withDraft(state, threadKey, { ...current, reviewComments });
    });
  };

/** Preview-browser element picks and annotations, and diff review comments, attached to a draft. */
export const attachedContextActions = {
  addElementContext,
  setElementContexts,
  removeElementContext,
  clearElementContexts,
  addPreviewAnnotation,
  setPreviewAnnotations,
  removePreviewAnnotation,
  addReviewComment,
  setReviewComments,
  removeReviewComment,
};
