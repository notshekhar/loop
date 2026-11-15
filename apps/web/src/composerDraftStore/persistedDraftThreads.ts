import { type EnvironmentId, ProjectId, type ScopedThreadRef, ThreadId } from "@loop/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@loop/runtime/environment";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import {
  type DraftThreadEnvMode,
  isRuntimeMode,
  type PersistedComposerDraftStoreState,
  type PersistedDraftThreadState,
} from "./schema";
import { normalizeLegacyComposerStorageKey, projectDraftKey } from "./targets";

type PersistedDraftThreadMaps = Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadKey" | "logicalProjectDraftThreadKeyByLogicalProjectKey"
>;

function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Legacy draft threads keyed by a raw `ThreadId` borrow the environment of their project. */
function environmentIdsFromProjectMappings(
  rawProjectDraftThreadIdByProjectKey: unknown,
): Map<ThreadId, EnvironmentId> {
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  const mappings = asRecord(rawProjectDraftThreadIdByProjectKey);
  if (!mappings) {
    return environmentIdByThreadId;
  }
  for (const [projectKey, threadId] of Object.entries(mappings)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    const projectRef = parseScopedProjectKey(projectKey);
    if (!projectRef) {
      continue;
    }
    const parsedThreadRef = parseScopedThreadKey(threadId);
    if (parsedThreadRef) {
      environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
      continue;
    }
    environmentIdByThreadId.set(threadId as ThreadId, projectRef.environmentId);
  }
  return environmentIdByThreadId;
}

function normalizePersistedPromotedTo(promotedToCandidate: unknown): ScopedThreadRef | null {
  const promotedToRecord = asRecord(promotedToCandidate);
  return promotedToRecord &&
    typeof promotedToRecord.environmentId === "string" &&
    promotedToRecord.environmentId.length > 0 &&
    typeof promotedToRecord.threadId === "string" &&
    promotedToRecord.threadId.length > 0
    ? scopeThreadRef(
        promotedToRecord.environmentId as EnvironmentId,
        promotedToRecord.threadId as ThreadId,
      )
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizePersistedDraftThread(
  threadKeyOrId: string,
  candidateDraftThread: Record<string, unknown>,
  environmentIdByThreadId: Map<ThreadId, EnvironmentId>,
): PersistedDraftThreadState | null {
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
  const threadId =
    parsedThreadRef?.threadId ??
    ((nonEmptyString(candidateDraftThread.threadId) as ThreadId | null) ??
      (threadKeyOrId as ThreadId));
  const environmentId =
    parsedThreadRef?.environmentId ??
    ((nonEmptyString(candidateDraftThread.environmentId) as EnvironmentId | null) ??
      environmentIdByThreadId.get(threadKeyOrId as ThreadId));
  const projectId = candidateDraftThread.projectId;
  const createdAt = candidateDraftThread.createdAt;
  const branch = candidateDraftThread.branch;
  const worktreePath = candidateDraftThread.worktreePath;
  const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
  const promotedTo = normalizePersistedPromotedTo(candidateDraftThread.promotedTo);
  if (typeof projectId !== "string" || projectId.length === 0 || environmentId === undefined) {
    return null;
  }
  const normalizedEnvironmentId = environmentId as EnvironmentId;
  return {
    threadId,
    environmentId: normalizedEnvironmentId,
    projectId: projectId as ProjectId,
    logicalProjectKey:
      nonEmptyString(candidateDraftThread.logicalProjectKey) ??
      (parsedThreadRef
        ? projectDraftKey(scopeProjectRef(normalizedEnvironmentId, projectId as ProjectId))
        : threadKeyOrId),
    createdAt:
      typeof createdAt === "string" && createdAt.length > 0 ? createdAt : new Date().toISOString(),
    runtimeMode: isRuntimeMode(candidateDraftThread.runtimeMode)
      ? candidateDraftThread.runtimeMode
      : DEFAULT_RUNTIME_MODE,
    interactionMode:
      candidateDraftThread.interactionMode === "plan" ||
      candidateDraftThread.interactionMode === "default"
        ? candidateDraftThread.interactionMode
        : DEFAULT_INTERACTION_MODE,
    branch: typeof branch === "string" ? branch : null,
    worktreePath: normalizedWorktreePath,
    envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
    startFromOrigin: candidateDraftThread.startFromOrigin === true,
    promotedTo,
  };
}

function normalizeRawDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  environmentIdByThreadId: Map<ThreadId, EnvironmentId>,
): Record<string, PersistedDraftThreadState> {
  const draftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {};
  const rawDraftThreads = asRecord(rawDraftThreadsByThreadId);
  if (!rawDraftThreads) {
    return draftThreadsByThreadKey;
  }
  for (const [threadKeyOrId, rawDraftThread] of Object.entries(rawDraftThreads)) {
    if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
      continue;
    }
    const candidateDraftThread = asRecord(rawDraftThread);
    if (!candidateDraftThread) {
      continue;
    }
    const draftThread = normalizePersistedDraftThread(
      threadKeyOrId,
      candidateDraftThread,
      environmentIdByThreadId,
    );
    if (draftThread) {
      draftThreadsByThreadKey[normalizeLegacyComposerStorageKey(threadKeyOrId)] = draftThread;
    }
  }
  return draftThreadsByThreadKey;
}

/**
 * Points a draft thread at the logical project that maps to it. Mutates
 * `draftThreadsByThreadKey`, creating a blank draft thread when the mapping
 * references one that was never persisted.
 */
function applyLogicalProjectMapping(
  draftThreadsByThreadKey: Record<string, PersistedDraftThreadState>,
  logicalProjectKey: string,
  threadKeyOrId: string,
): void {
  const projectRef = parseScopedProjectKey(logicalProjectKey);
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
  const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
  if (!projectRef) {
    const existingDraftThread = draftThreadsByThreadKey[threadKey];
    if (existingDraftThread && !existingDraftThread.logicalProjectKey) {
      draftThreadsByThreadKey[threadKey] = {
        ...existingDraftThread,
        logicalProjectKey,
      };
    }
    return;
  }
  if (!draftThreadsByThreadKey[threadKey]) {
    draftThreadsByThreadKey[threadKey] = {
      threadId: parsedThreadRef?.threadId ?? (threadKey as ThreadId),
      environmentId: projectRef.environmentId,
      projectId: projectRef.projectId,
      logicalProjectKey,
      createdAt: new Date().toISOString(),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
      promotedTo: null,
    };
  } else if (
    draftThreadsByThreadKey[threadKey]?.projectId !== projectRef.projectId ||
    draftThreadsByThreadKey[threadKey]?.environmentId !== projectRef.environmentId
  ) {
    draftThreadsByThreadKey[threadKey] = {
      ...draftThreadsByThreadKey[threadKey]!,
      threadId: draftThreadsByThreadKey[threadKey]!.threadId,
      environmentId: projectRef.environmentId,
      projectId: projectRef.projectId,
      logicalProjectKey,
    };
  }
}

function applyLogicalProjectMappings(
  rawProjectDraftThreadIdByProjectKey: unknown,
  draftThreadsByThreadKey: Record<string, PersistedDraftThreadState>,
): Record<string, string> {
  const logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {};
  const mappings = asRecord(rawProjectDraftThreadIdByProjectKey);
  if (!mappings) {
    return logicalProjectDraftThreadKeyByLogicalProjectKey;
  }
  for (const [logicalProjectKey, threadKeyOrId] of Object.entries(mappings)) {
    if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
      continue;
    }
    logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] =
      normalizeLegacyComposerStorageKey(threadKeyOrId);
    applyLogicalProjectMapping(draftThreadsByThreadKey, logicalProjectKey, threadKeyOrId);
  }
  return logicalProjectDraftThreadKeyByLogicalProjectKey;
}

export function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectKey: unknown,
): PersistedDraftThreadMaps {
  const environmentIdByThreadId = environmentIdsFromProjectMappings(
    rawProjectDraftThreadIdByProjectKey,
  );
  const draftThreadsByThreadKey = normalizeRawDraftThreads(
    rawDraftThreadsByThreadId,
    environmentIdByThreadId,
  );
  const logicalProjectDraftThreadKeyByLogicalProjectKey = applyLogicalProjectMappings(
    rawProjectDraftThreadIdByProjectKey,
    draftThreadsByThreadKey,
  );
  return { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey };
}
