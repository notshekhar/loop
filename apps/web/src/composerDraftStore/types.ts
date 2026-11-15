import {
  type EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  type PreviewAnnotationPayload,
  RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@loop/contracts";
import type { ChatAttachment, ChatImageAttachment } from "../types";
import type { TerminalContextDraft } from "../lib/terminalContext";
import type { ElementContextDraft, ElementContextSelection } from "../lib/elementContext";
import type { ReviewCommentContext } from "../reviewCommentContext";
import type {
  DraftId,
  DraftThreadEnvMode,
  PersistedComposerImageAttachment,
  ProviderOptionSelectionsByProvider,
} from "./schema";

/**
 * One staged attachment.
 *
 * Still named for images because that is what it almost always is and renaming
 * it reaches ~40 call sites, but `type` is the contract's union now: loop takes
 * PDFs as well, on the models whose provider can receive them. `previewUrl` is
 * empty for anything that is not an image — the chip falls back to the file
 * name, which is also what the timeline already does for an attachment it
 * cannot show.
 */
export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "type"> {
  type: ChatAttachment["type"];
  previewUrl: string;
  file: File;
}

/**
 * Composer content keyed by either a draft session (`DraftId`) or a real server
 * thread (`ScopedThreadRef`). This is the editable payload shown in the composer.
 */
export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  /**
   * Element-pick attachments captured from the in-app preview browser. The
   * full payload (selector / html / styles / source frame) is persisted
   * inline because — unlike terminal contexts — there's no live session to
   * re-derive the snapshot from on reload.
   */
  elementContexts: ElementContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  /**
   * Per-instance model selection. Keyed by `ProviderInstanceId` (open
   * branded slug) so a default `codex` instance and a user-authored
   * `codex_personal` instance each persist their own selected model. Every
   * historical `ProviderDriverKind` literal (`codex` / `claudeAgent` / `cursor` /
   * `opencode`) also satisfies the `ProviderInstanceId` slug pattern, so
   * legacy kind-keyed drafts round-trip unchanged.
   */
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  /** Routing key of the last picked instance (see `modelSelectionByProvider`). */
  activeProvider: ProviderInstanceId | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

/**
 * Mutable routing and execution context for a pre-thread draft session.
 *
 * Unlike a real server thread, a draft session can still change target
 * environment/worktree configuration before the first send.
 */
export interface DraftSessionState {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  logicalProjectKey: string;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  promotedTo?: ScopedThreadRef | null;
}

export type DraftThreadState = DraftSessionState;

/**
 * Draft session metadata paired with its stable draft-session identity.
 */
export interface ProjectDraftSession extends DraftSessionState {
  draftId: DraftId;
}

/** Draft-session fields a caller may set when creating or re-targeting a draft session. */
export interface DraftThreadOptions {
  threadId?: ThreadId;
  branch?: string | null;
  worktreePath?: string | null;
  createdAt?: string;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
}

/**
 * App-facing composer identity:
 * - `DraftId` for pre-thread draft sessions
 * - `ScopedThreadRef` for server-backed threads
 *
 * Raw `ThreadId` is intentionally excluded so callers cannot drop environment
 * identity for real threads.
 */
export type ComposerThreadTarget = ScopedThreadRef | DraftId;

/**
 * Persisted store for composer content plus draft-session metadata.
 *
 * The store intentionally models two domains:
 * - draft sessions keyed by `DraftId`
 * - server thread composer state keyed by `ScopedThreadRef`
 */
export interface ComposerDraftStoreState {
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
  draftThreadsByThreadKey: Record<string, DraftThreadState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyActiveProvider: ProviderInstanceId | null;
  /** Returns the editable composer content for a draft session or server thread. */
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  /** Looks up the active draft session for a logical project identity. */
  getDraftThreadByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  /** Reads mutable draft-session metadata by `DraftId`. */
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  /** Resolves a server-thread ref back to a matching draft session when one exists. */
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null;
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null;
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean;
  /** Creates or updates the draft session tracked for a logical project. */
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: DraftThreadOptions,
  ) => void;
  /** Creates or updates the draft session tracked for a concrete project ref. */
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: DraftThreadOptions,
  ) => void;
  /** Updates mutable draft-session metadata without touching composer content. */
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectRef?: ScopedProjectRef;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void;
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void;
  /** Marks a draft session as being promoted to a real server thread. */
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void;
  /** Removes draft-session metadata after promotion is complete. */
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void;
  clearDraftThread: (threadRef: ComposerThreadTarget) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: {
      /**
       * Replace the stored entry outright instead of preserving its
       * existing options when the incoming selection has none. Used when
       * the selection is a complete snapshot (e.g. carried from another
       * thread) rather than a model-only change.
       */
      replaceOptions?: boolean;
    },
  ) => void;
  /** Replace the model options for one or more providers in the draft. */
  setModelOptions: (
    threadRef: ComposerThreadTarget,
    modelOptions:
      | Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>
      | null
      | undefined,
  ) => void;
  applyStickyState: (threadRef: ComposerThreadTarget) => void;
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined;
      model?: string | null | undefined;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void;
  setInteractionMode: (
    threadRef: ComposerThreadTarget,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (threadRef: ComposerThreadTarget, image: ComposerImageAttachment) => void;
  addImages: (threadRef: ComposerThreadTarget, images: ComposerImageAttachment[]) => void;
  removeImage: (threadRef: ComposerThreadTarget, imageId: string) => void;
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadRef: ComposerThreadTarget, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  /**
   * Append a fresh element pick to the draft. Returns true when accepted,
   * false when deduped against an existing pick of the same element.
   */
  addElementContext: (
    threadRef: ComposerThreadTarget,
    selection: ElementContextSelection,
  ) => boolean;
  /**
   * Replace the entire element-contexts list (used by send-failure retry to
   * restore the pre-send snapshot).
   */
  setElementContexts: (
    threadRef: ComposerThreadTarget,
    contexts: ReadonlyArray<ElementContextDraft>,
  ) => void;
  removeElementContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearElementContexts: (threadRef: ComposerThreadTarget) => void;
  addPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotation: PreviewAnnotationPayload,
  ) => void;
  setPreviewAnnotations: (
    threadRef: ComposerThreadTarget,
    annotations: ReadonlyArray<PreviewAnnotationPayload>,
  ) => void;
  removePreviewAnnotation: (threadRef: ComposerThreadTarget, annotationId: string) => void;
  addReviewComment: (threadRef: ComposerThreadTarget, comment: ReviewCommentContext) => void;
  setReviewComments: (
    threadRef: ComposerThreadTarget,
    comments: ReadonlyArray<ReviewCommentContext>,
  ) => void;
  removeReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void;
  clearPersistedAttachments: (threadRef: ComposerThreadTarget) => void;
  syncPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  clearComposerContent: (threadRef: ComposerThreadTarget) => void;
  /**
   * Clears only the prompt text and image attachments, preserving terminal /
   * element contexts, preview annotations, and review comments. Used by the
   * prompt stash, which can only round-trip text + images: clearing the
   * session-bound contexts would destroy state nothing can restore.
   */
  clearComposerPromptAndImages: (threadRef: ComposerThreadTarget) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

export interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}

export type ComposerDraftStoreSet = (
  partial:
    | ComposerDraftStoreState
    | Partial<ComposerDraftStoreState>
    | ((
        state: ComposerDraftStoreState,
      ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
  replace?: false,
) => void;
export type ComposerDraftStoreGet = () => ComposerDraftStoreState;

/** Builds one store action from the store's `set` / `get`. */
export type ComposerDraftActionBuilder<K extends keyof ComposerDraftStoreState> = (
  set: ComposerDraftStoreSet,
  get: ComposerDraftStoreGet,
) => ComposerDraftStoreState[K];
