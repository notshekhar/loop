import {
  ModelSelection,
  ProviderDriverKind,
  type PreviewAnnotationPayload,
  ThreadId,
} from "@loop/contracts";
import { type TerminalContextDraft, normalizeTerminalContextText } from "../lib/terminalContext";
import type { ElementContextDraft } from "../lib/elementContext";
import type { ReviewCommentContext } from "../reviewCommentContext";
import type { PersistedComposerImageAttachment } from "./schema";
import type {
  ComposerDraftModelState,
  ComposerDraftStoreState,
  ComposerImageAttachment,
  ComposerThreadDraftState,
} from "./types";

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_ELEMENT_CONTEXTS: ElementContextDraft[] = [];
const EMPTY_PREVIEW_ANNOTATIONS: PreviewAnnotationPayload[] = [];
const EMPTY_REVIEW_COMMENTS: ReviewCommentContext[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_ELEMENT_CONTEXTS);
Object.freeze(EMPTY_PREVIEW_ANNOTATIONS);
Object.freeze(EMPTY_REVIEW_COMMENTS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderDriverKind, ModelSelection>> =
  Object.freeze({});
export const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
});

export const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  elementContexts: EMPTY_ELEMENT_CONTEXTS,
  previewAnnotations: EMPTY_PREVIEW_ANNOTATIONS,
  reviewComments: EMPTY_REVIEW_COMMENTS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

/**
 * Canonical factory for a blank `ComposerThreadDraftState`. Exported so tests
 * (and any other call sites) can build a draft without re-declaring every
 * slice — adding a new field to the interface (e.g. `elementContexts`) only
 * has to be reflected here, not in every stub.
 */
export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

export function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.elementContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    draft.reviewComments.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

export function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeDraftThreadPreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}


/**
 * Writes `nextDraft` under `threadKey`, dropping the entry instead when the
 * draft has become empty so blank drafts never linger in storage.
 */
export function withDraft(
  state: Pick<ComposerDraftStoreState, "draftsByThreadKey">,
  threadKey: string,
  nextDraft: ComposerThreadDraftState,
): Pick<ComposerDraftStoreState, "draftsByThreadKey"> {
  const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
  if (shouldRemoveDraft(nextDraft)) {
    delete nextDraftsByThreadKey[threadKey];
  } else {
    nextDraftsByThreadKey[threadKey] = nextDraft;
  }
  return { draftsByThreadKey: nextDraftsByThreadKey };
}
