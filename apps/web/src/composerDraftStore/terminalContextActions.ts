import { ensureInlineTerminalContextPlaceholders } from "../lib/terminalContext";
import {
  createEmptyThreadDraft,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  terminalContextDedupKey,
  withDraft,
} from "./draftContent";
import { DraftId } from "./schema";
import { resolveComposerDraftKey, resolveComposerThreadId } from "./targets";
import type { ComposerDraftActionBuilder, ComposerThreadDraftState } from "./types";

const setTerminalContexts: ComposerDraftActionBuilder<"setTerminalContexts"> =
  (set, get) => (threadRef, contexts) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    const threadId = resolveComposerThreadId(get(), threadRef);
    if (!threadKey || !threadId) {
      return;
    }
    const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      return withDraft(state, threadKey, {
        ...existing,
        prompt: ensureInlineTerminalContextPlaceholders(
          existing.prompt,
          normalizedContexts.length,
        ),
        terminalContexts: normalizedContexts,
      });
    });
  };

const insertTerminalContext: ComposerDraftActionBuilder<"insertTerminalContext"> =
  (set, get) => (threadRef, prompt, context, index) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    const threadId = resolveComposerThreadId(get(), threadRef);
    if (!threadKey || !threadId) {
      return false;
    }
    let inserted = false;
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      const normalizedContext = normalizeTerminalContextForThread(threadId, context);
      if (!normalizedContext) {
        return state;
      }
      const dedupKey = terminalContextDedupKey(normalizedContext);
      if (
        existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
        existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
      ) {
        return state;
      }
      inserted = true;
      const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
      const nextDraft: ComposerThreadDraftState = {
        ...existing,
        prompt,
        terminalContexts: [
          ...existing.terminalContexts.slice(0, boundedIndex),
          normalizedContext,
          ...existing.terminalContexts.slice(boundedIndex),
        ],
      };
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [threadKey]: nextDraft,
        },
      };
    });
    return inserted;
  };

const addTerminalContext: ComposerDraftActionBuilder<"addTerminalContext"> =
  (_set, get) => (threadRef, context) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    const threadId = resolveComposerThreadId(get(), threadRef);
    if (!threadKey || !threadId) {
      return;
    }
    get().addTerminalContexts(typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef, [
      context,
    ]);
  };

const addTerminalContexts: ComposerDraftActionBuilder<"addTerminalContexts"> =
  (set, get) => (threadRef, contexts) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef);
    const threadId = resolveComposerThreadId(get(), threadRef);
    if (!threadKey || !threadId || contexts.length === 0) {
      return;
    }
    set((state) => {
      const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
      const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
        ...existing.terminalContexts,
        ...contexts,
      ]).slice(existing.terminalContexts.length);
      if (acceptedContexts.length === 0) {
        return state;
      }
      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [threadKey]: {
            ...existing,
            prompt: ensureInlineTerminalContextPlaceholders(
              existing.prompt,
              existing.terminalContexts.length + acceptedContexts.length,
            ),
            terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
          },
        },
      };
    });
  };

const removeTerminalContext: ComposerDraftActionBuilder<"removeTerminalContext"> =
  (set, get) => (threadRef, contextId) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0 || contextId.length === 0) {
      return;
    }
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) {
        return state;
      }
      return withDraft(state, threadKey, {
        ...current,
        terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
      });
    });
  };

const clearTerminalContexts: ComposerDraftActionBuilder<"clearTerminalContexts"> =
  (set, get) => (threadRef) => {
    const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
    if (threadKey.length === 0) {
      return;
    }
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current || current.terminalContexts.length === 0) {
        return state;
      }
      return withDraft(state, threadKey, { ...current, terminalContexts: [] });
    });
  };

/** Terminal-output snippets attached to the draft, kept in sync with their inline placeholders. */
export const terminalContextActions = {
  setTerminalContexts,
  insertTerminalContext,
  addTerminalContext,
  addTerminalContexts,
  removeTerminalContext,
  clearTerminalContexts,
};
