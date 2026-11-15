import {
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@loop/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@loop/runtime/environment";
import { DraftId } from "./schema";
import type {
  ComposerDraftStoreState,
  ComposerThreadDraftState,
  ComposerThreadTarget,
} from "./types";

export function projectDraftKey(projectRef: ScopedProjectRef): string {
  return scopedProjectKey(projectRef);
}

export function logicalProjectDraftKey(logicalProjectKey: string): string {
  return logicalProjectKey.trim();
}

/**
 * Runtime composer storage key for app-facing identities only.
 *
 * Draft sessions are keyed by `DraftId`. Real threads are keyed by
 * `ScopedThreadRef` so environment identity is always preserved.
 */
function composerTargetKey(target: ScopedThreadRef | DraftId): string {
  if (typeof target === "string") {
    return target.trim();
  }
  return scopedThreadKey(target);
}

/**
 * Legacy persisted data may still be keyed by a raw `ThreadId`. This helper is
 * intentionally migration-only so live code cannot accidentally accept that
 * incomplete identity.
 */
export function normalizeLegacyComposerStorageKey(
  threadKeyOrId: string,
  options?: {
    environmentId?: EnvironmentId;
  },
): string {
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
  if (parsedThreadRef) {
    return composerTargetKey(parsedThreadRef);
  }
  if (options?.environmentId) {
    return composerTargetKey(scopeThreadRef(options.environmentId, threadKeyOrId as ThreadId));
  }
  return threadKeyOrId;
}

export function composerThreadRefFromKey(threadKey: string): ScopedThreadRef | null {
  return parseScopedThreadKey(threadKey);
}

type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

function normalizeComposerTarget(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ComposerThreadTarget | null {
  if (typeof target === "string") {
    const draftId = target.trim();
    return draftId.length > 0 ? DraftId.make(draftId) : null;
  }
  return target;
}

export function resolveComposerDraftKey(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): string | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    const scopedKey = composerTargetKey(normalizedTarget);
    if (state.draftsByThreadKey[scopedKey]) {
      return scopedKey;
    }
    for (const [draftId, draftSession] of Object.entries(state.draftThreadsByThreadKey)) {
      if (
        draftSession.environmentId === normalizedTarget.environmentId &&
        draftSession.threadId === normalizedTarget.threadId
      ) {
        return draftId;
      }
    }
    return scopedKey;
  }
  const threadKey = composerTargetKey(normalizedTarget);
  return threadKey.length > 0 ? threadKey : null;
}

export function resolveComposerThreadId(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ThreadId | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    return normalizedTarget.threadId;
  }
  return state.draftThreadsByThreadKey[normalizedTarget]?.threadId ?? null;
}

export function getComposerDraftState(
  state: Pick<ComposerDraftStoreState, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  target: ComposerThreadTarget,
): ComposerThreadDraftState | null {
  const threadKey = resolveComposerDraftKey(state, target);
  if (!threadKey) {
    return null;
  }
  return state.draftsByThreadKey[threadKey] ?? null;
}

