import { type ScopedProjectRef, type ScopedThreadRef, ThreadId } from "@loop/contracts";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { revokeDraftThreadPreviewUrls } from "./draftContent";
import type { DraftId } from "./schema";
import type {
  ComposerDraftStoreState,
  DraftSessionState,
  DraftThreadOptions,
  DraftThreadState,
  ProjectDraftSession,
} from "./types";

export function isComposerThreadKeyInUse(
  mappings: Record<string, string>,
  threadKey: string,
): boolean {
  return Object.values(mappings).includes(threadKey);
}

export function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession {
  return {
    draftId,
    ...draftSession,
  };
}

export function createDraftThreadState(
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
  logicalProjectKey: string,
  existingThread: DraftThreadState | undefined,
  options?: DraftThreadOptions,
): DraftThreadState {
  // A project change (including switching environments within a logical
  // project) invalidates machine-specific context: the branch may not exist
  // there and the worktree path certainly doesn't. The user's *intent* —
  // env mode and start-from-origin — is machine-independent and carries.
  const projectChanged =
    existingThread !== undefined &&
    (existingThread.environmentId !== projectRef.environmentId ||
      existingThread.projectId !== projectRef.projectId);
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextBranch =
    options?.branch === undefined
      ? projectChanged
        ? null
        : (existingThread?.branch ?? null)
      : (options.branch ?? null);
  const nextStartFromOrigin =
    options?.startFromOrigin === undefined
      ? (existingThread?.startFromOrigin ?? false)
      : options.startFromOrigin;
  return {
    threadId,
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    logicalProjectKey,
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    startFromOrigin: nextStartFromOrigin,
    promotedTo: null,
  };
}

export function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function isDraftThreadPromoting(
  draftThread: DraftThreadState | null | undefined,
): boolean {
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined;
}

export function draftThreadsEqual(
  left: DraftThreadState | undefined,
  right: DraftThreadState,
): boolean {
  return (
    !!left &&
    left.threadId === right.threadId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.logicalProjectKey === right.logicalProjectKey &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode &&
    left.startFromOrigin === right.startFromOrigin &&
    scopedThreadRefsEqual(left.promotedTo, right.promotedTo)
  );
}

export function removeDraftThreadReferences(
  state: Pick<
    ComposerDraftStoreState,
    | "draftThreadsByThreadKey"
    | "draftsByThreadKey"
    | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  >,
  threadKey: string,
): Pick<
  ComposerDraftStoreState,
  | "draftThreadsByThreadKey"
  | "draftsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const nextLogicalMappings = Object.fromEntries(
    Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
      ([, draftThreadKey]) => draftThreadKey !== threadKey,
    ),
  ) as Record<string, string>;
  const { [threadKey]: _removedDraftThread, ...restDraftThreadsByThreadKey } =
    state.draftThreadsByThreadKey;
  const { [threadKey]: removedComposerDraft, ...restDraftsByThreadKey } = state.draftsByThreadKey;
  revokeDraftThreadPreviewUrls(removedComposerDraft);
  return {
    draftsByThreadKey: restDraftsByThreadKey,
    draftThreadsByThreadKey: restDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
  };
}

/**
 * Applies `setDraftThreadContext` options to an existing draft session.
 * Mirrors createDraftThreadState: a project/environment change drops
 * machine-specific context (branch, worktree path) but keeps the user's env
 * mode and start-from-origin intent.
 */
export function nextDraftThreadContext(
  existing: DraftThreadState,
  nextProjectRef: ScopedProjectRef,
  options: Omit<DraftThreadOptions, "threadId">,
): DraftThreadState {
  const projectChanged =
    nextProjectRef.environmentId !== existing.environmentId ||
    nextProjectRef.projectId !== existing.projectId;
  const nextWorktreePath =
    options.worktreePath === undefined
      ? projectChanged
        ? null
        : existing.worktreePath
      : (options.worktreePath ?? null);
  const nextBranch =
    options.branch === undefined
      ? projectChanged
        ? null
        : existing.branch
      : (options.branch ?? null);
  const nextStartFromOrigin =
    options.startFromOrigin === undefined ? existing.startFromOrigin : options.startFromOrigin;
  return {
    threadId: existing.threadId,
    environmentId: nextProjectRef.environmentId,
    projectId: nextProjectRef.projectId,
    logicalProjectKey: existing.logicalProjectKey,
    createdAt:
      options.createdAt === undefined
        ? existing.createdAt
        : options.createdAt || existing.createdAt,
    runtimeMode: options.runtimeMode ?? existing.runtimeMode,
    interactionMode: options.interactionMode ?? existing.interactionMode,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    envMode: options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
    startFromOrigin: nextStartFromOrigin,
    promotedTo: existing.promotedTo ?? null,
  };
}
