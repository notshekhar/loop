/**
 * The single seam between this UI and loop.
 *
 * Everything the app knows about loop goes through `loopCall` — one JSON-RPC
 * request/response — and `onLoopEvent` — loop's `session.event` notifications.
 * Nothing above this file speaks WebSocket, and nothing below it knows what a
 * thread or a project is.
 *
 * Two shells run the same UI:
 *
 *   - `loop serve`: one WebSocket to the server.
 *   - Electron: one `loop rpc` child, spoken to over the preload bridge.
 *
 * In both, `cwd` rides as a call parameter rather than selecting a backend:
 * loop's sessions carry their own cwd, so a single agent process serves every
 * project (see apps/desktop/src/loopProcess.ts).
 *
 * The Electron bridge is injected on `window.loop` by the preload script; when
 * it is absent we are in a browser and take the socket path.
 */

import { createWorkspaceBridges, type WorkspaceBridges } from "./workspaceBridges";

export interface LoopEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly part: unknown;
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export type ReadWorkspaceFileResult =
  | {
      readonly ok: true;
      readonly relativePath: string;
      readonly contents: string;
      readonly byteLength: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly failure: string };

/**
 * Filesystem access, which only the desktop shell has.
 *
 * loop speaks an agent protocol with no file operations, and a browser has no
 * filesystem, so this is the one capability that genuinely differs between the
 * two shells rather than merely being routed differently.
 */
export type ReadWorkspaceAssetResult =
  | { readonly ok: true; readonly data: Uint8Array; readonly mimeType: string }
  | { readonly ok: false; readonly failure: string };

export type WriteWorkspaceFileResult =
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false; readonly failure: string };

export interface LoopFilesystemBridge {
  list(cwd: string): Promise<{ entries: readonly WorkspaceEntry[]; truncated: boolean }>;
  read(cwd: string, relativePath: string): Promise<ReadWorkspaceFileResult>;
  /** Absent on a shell predating editable files; callers check. */
  write?(cwd: string, relativePath: string, contents: string): Promise<WriteWorkspaceFileResult>;
  /**
   * Raw bytes for a non-text file. Optional: older shells only have `read`,
   * which refuses binary, and the caller falls back to reporting the asset as
   * unavailable rather than crashing.
   */
  readAsset?(absolutePath: string): Promise<ReadWorkspaceAssetResult>;
  browse(
    partialPath: string,
    cwd: string | undefined,
  ): Promise<{ parentPath: string; entries: readonly { name: string; fullPath: string }[] } | null>;
  /**
   * Make a folder, for "Create & Add" in the project picker. Optional: a shell
   * predating it cannot create the folder, and the caller says so rather than
   * failing with the browse's "that is not a folder".
   */
  createDirectory?(
    path: string,
  ): Promise<{ ok: true; path: string } | { ok: false; failure: string }>;
}

export interface TerminalSnapshot {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly status: "starting" | "running" | "exited" | "error";
  readonly pid: number | null;
  readonly history: string;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly label: string;
  readonly updatedAt: string;
  /**
   * Output chunks this shell had produced when the snapshot was taken — the
   * boundary between `history` and live output. See `attachTerminal`.
   *
   * Optional because only a desktop shell new enough to report it does; an
   * attach that does not get one falls back to trusting `history` alone.
   */
  readonly sequence?: number;
}

export interface TerminalOutput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly type: "output" | "exited" | "closed" | "started";
  /** Present on `started`: the freshly spawned shell. See attachTerminal. */
  readonly snapshot?: TerminalSnapshot;
  readonly data?: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: number | null;
  /** On `output`: this chunk's position in the stream. See TerminalSnapshot. */
  readonly sequence?: number;
}

/** PTYs, which like the filesystem only the desktop shell can provide. */
export interface LoopPtyBridge {
  open(input: {
    threadId: string;
    terminalId: string;
    cwd: string;
    worktreePath?: string | null;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  }): Promise<TerminalSnapshot>;
  snapshot(threadId: string, terminalId: string): Promise<TerminalSnapshot | null>;
  /** Absent on a shell predating the metadata subscription; callers check. */
  list?(): Promise<readonly TerminalSnapshot[]>;
  write(threadId: string, terminalId: string, data: string): Promise<void>;
  resize(threadId: string, terminalId: string, cols: number, rows: number): Promise<void>;
  clear(threadId: string, terminalId: string): Promise<void>;
  close(threadId: string, terminalId: string | undefined): Promise<void>;
  onOutput(listener: (event: TerminalOutput) => void): () => void;
}

export interface GitRef {
  readonly name: string;
  readonly isRemote: boolean;
  readonly remoteName?: string;
  readonly current: boolean;
  readonly isDefault: boolean;
  readonly worktreePath: string | null;
}

export interface GitStatus {
  readonly isRepo: boolean;
  /** `isRepo` is true only because the folder CONTAINS repositories; it has no
   * branch of its own. Absent on a real single repository, and on any shell
   * older than the flag. */
  readonly isWorkspaceRoot?: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly isDefaultRef: boolean;
  readonly refName: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly workingTree: {
    readonly files: ReadonlyArray<{ path: string; insertions: number; deletions: number }>;
    readonly insertions: number;
    readonly deletions: number;
  };
  /**
   * The same changes with the index and the working tree kept apart.
   *
   * Optional because a shell older than this field simply does not send it, and
   * the surfaces reading `workingTree` above must keep working against one.
   * Empty on a workspace root, which has no single index.
   */
  readonly changes?: ReadonlyArray<GitFileChange>;
  readonly hasConflicts?: boolean;
  readonly stagedCount?: number;
  readonly unstagedCount?: number;
  readonly hasUpstream: boolean;
  readonly aheadCount: number;
  readonly behindCount: number;
}

/** git's XY status letters. */
export type GitStatusCode = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?" | "!";

export type GitConflictKind =
  | "both-modified"
  | "both-added"
  | "both-deleted"
  | "added-by-us"
  | "added-by-them"
  | "deleted-by-us"
  | "deleted-by-them";

/** One changed file. A file may be staged AND unstaged; see `staged`/`unstaged`. */
export interface GitFileChange {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus: GitStatusCode | null;
  readonly worktreeStatus: GitStatusCode | null;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  /** Present iff unmerged, in which case it is in neither group. */
  readonly conflict?: GitConflictKind;
  readonly stagedInsertions: number;
  readonly stagedDeletions: number;
  readonly unstagedInsertions: number;
  readonly unstagedDeletions: number;
}

/**
 * Git, from the shell: reads, plus the writes the UI itself owns.
 *
 * The agent is still what writes *code*. These are the user acting on their own
 * repository through buttons they clicked — commit, push, open a PR, and the
 * `init` for a folder that is not a repo yet — which is a different thing, and
 * every one of them used to fail as "not supported by loop's desktop app".
 */
export interface GitDiffPreviewSource {
  readonly id: string;
  readonly kind: "working-tree" | "branch-range";
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly diff: string;
  readonly diffHash: string;
  readonly truncated: boolean;
}

export type GitStackedAction = "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
export type GitActionPhase = "branch" | "commit" | "push" | "pr";

/**
 * A progress event from the shell, already stamped with which action it belongs
 * to — a second commit started before the first finished must not have its
 * output painted into the wrong toast.
 */
export interface GitActionProgressMessage {
  readonly actionId: string;
  readonly cwd: string;
  readonly action: GitStackedAction;
  readonly kind:
    | "action_started"
    | "phase_started"
    | "hook_started"
    | "hook_output"
    | "hook_finished";
  readonly phases?: readonly GitActionPhase[];
  readonly phase?: GitActionPhase;
  readonly label?: string;
  readonly hookName?: string | null;
  readonly stream?: "stdout" | "stderr";
  readonly text?: string;
  readonly exitCode?: number | null;
  readonly durationMs?: number | null;
}

export interface GitStackedActionOutcome {
  readonly action: GitStackedAction;
  readonly branch: { status: "created" | "skipped_not_requested"; name?: string };
  readonly commit: {
    status: "created" | "skipped_no_changes" | "skipped_not_requested";
    commitSha?: string;
    subject?: string;
  };
  readonly push: {
    status: "pushed" | "skipped_not_requested" | "skipped_up_to_date";
    branch?: string;
    upstreamBranch?: string;
    setUpstream?: boolean;
  };
  readonly pr: {
    status: "created" | "opened_existing" | "skipped_not_requested";
    url?: string;
    number?: number;
    baseBranch?: string;
    headBranch?: string;
    title?: string;
  };
}

export interface LoopGitBridge {
  refs(cwd: string): Promise<{
    refs: readonly GitRef[];
    isRepo: boolean;
    hasPrimaryRemote: boolean;
    totalCount: number;
  }>;
  status(cwd: string): Promise<GitStatus>;
  /** Absent on a half-updated shell, so callers must check before calling. */
  init?(cwd: string): Promise<void>;
  /** Same: added after `init`, so an older shell has no diff pane. */
  diffPreview?(
    cwd: string,
    options: { baseRef?: string; ignoreWhitespace?: boolean; contextLines?: number },
  ): Promise<{
    isRepo: boolean;
    sources: readonly GitDiffPreviewSource[];
    /** Set only when `cwd` holds repositories rather than being one. */
    workspaceRepositories?: readonly {
      path: string;
      branch: string | null;
      filesChanged: number;
      insertions: number;
      deletions: number;
    }[];
  }>;
  /**
   * Commit / push / PR. Resolves with git's own message on failure rather than
   * rejecting, so the toast shows "lint failed" and not an IPC wrapper.
   */
  runStackedAction?(input: {
    actionId: string;
    cwd: string;
    action: GitStackedAction;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  }): Promise<{ ok: true; value: GitStackedActionOutcome } | { ok: false; error: string }>;
  /** Progress for every in-flight action; filter by `actionId`. */
  onActionProgress?(listener: (event: GitActionProgressMessage) => void): () => void;
  /**
   * Index writes. All optional: a shell that predates them has no SCM panel,
   * and a missing method must read as "not available here" rather than a
   * TypeError inside a click handler.
   *
   * Each resolves with the repository's fresh status, so the caller repaints
   * from what git did rather than predicting it.
   */
  stage?(cwd: string, paths: readonly string[]): Promise<GitStatus>;
  unstage?(cwd: string, paths: readonly string[]): Promise<GitStatus>;
  discard?(
    cwd: string,
    input: { tracked?: readonly string[]; untracked?: readonly string[] },
  ): Promise<GitStatus>;
  /** Partial staging: exact index content, working tree untouched. */
  stageContent?(cwd: string, path: string, content: string): Promise<GitStatus>;
  /** File content at HEAD or in the index, for computing a partial stage. */
  fileAtRevision?(cwd: string, revision: "HEAD" | "index", path: string): Promise<string | null>;
  conflictStages?(
    cwd: string,
    path: string,
  ): Promise<{ base: string | null; ours: string | null; theirs: string | null }>;
  /** What source-control tooling the machine has, for the settings panel. */
  discover?(): Promise<GitDiscovery>;
}

/** Plain nulls on the wire; the handler lifts them into the contract's Options. */
export interface GitDiscovery {
  readonly versionControlSystems: ReadonlyArray<{
    kind: "git" | "jj" | "unknown";
    implemented: boolean;
    label: string;
    executable: string;
    status: "available" | "missing";
    version: string | null;
    installHint: string;
    detail: string | null;
  }>;
  readonly sourceControlProviders: ReadonlyArray<{
    kind: "github" | "gitlab" | "azure-devops" | "bitbucket" | "unknown";
    label: string;
    executable: string;
    status: "available" | "missing";
    version: string | null;
    installHint: string;
    detail: string | null;
    auth: {
      status: "authenticated" | "unauthenticated" | "unknown";
      account: string | null;
      host: string | null;
      detail: string | null;
    };
  }>;
}

/**
 * Launching things outside the app.
 *
 * Deliberately generic: the editor table lives in the contracts, so the shell
 * only answers "does this command exist" and "run it" rather than keeping a
 * second copy of the list that would drift.
 */
export interface LoopShellBridge {
  which(commands: readonly string[]): Promise<Record<string, string | null>>;
  /** A null command means the OS file manager. */
  launch(
    command: string | null,
    args: readonly string[],
    target: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface RepositoryInfo {
  readonly provider: "github";
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

type ShellResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Repository-level GitHub work: find one, bring one down, put one up. */
export interface LoopSourceControlBridge {
  lookup(repository: string): Promise<ShellResult<RepositoryInfo | null>>;
  clone(input: {
    repository?: string;
    remoteUrl?: string;
    destinationPath: string;
    protocol?: "auto" | "ssh" | "https";
  }): Promise<ShellResult<{ cwd: string; remoteUrl: string; repository: RepositoryInfo | null }>>;
  publish(input: {
    cwd: string;
    repository: string;
    visibility: "private" | "public";
    remoteName?: string;
  }): Promise<
    ShellResult<{
      repository: RepositoryInfo;
      remoteName: string;
      remoteUrl: string;
      branch: string;
      upstreamBranch: string | null;
      status: "pushed" | "remote_added";
    }>
  >;
}

/** The host window itself — the one bridge that is about chrome, not data. */
export interface LoopWindowBridge {
  isFullscreen(): Promise<boolean>;
  onFullscreenChange(listener: (fullscreen: boolean) => void): () => void;
}

/** The preload bridge. Kept structural so the renderer needs no Electron types. */
interface LoopDesktopBridge {
  call(method: string, params: unknown, cwd: string | undefined): Promise<unknown>;
  onEvent(listener: (event: LoopEvent) => void): () => void;
  /**
   * Core up/down. Optional: an older preload does not send it, and a shell
   * without it is exactly the shell this had before — no worse.
   */
  onStatus?(listener: (running: boolean) => void): () => void;
  /**
   * In-app updates — upstream's `DesktopBridge` update surface, hung off this
   * bridge rather than `window.desktopBridge`. See components/desktopUpdateBridge.ts.
   * Typed as `unknown` to keep this module free of contract imports.
   */
  updater?: unknown;
  /** Folder-less calls route here. */
  anchorCwd(): Promise<string | undefined>;
  fs?: LoopFilesystemBridge;
  pty?: LoopPtyBridge;
  git?: LoopGitBridge;
  shell?: LoopShellBridge;
  sourceControl?: LoopSourceControlBridge;
  window?: LoopWindowBridge;
  /**
   * The browser panel's webview control surface — upstream's
   * `DesktopPreviewBridge`, which lives here rather than on
   * `window.desktopBridge` (see components/preview/previewBridge.ts). Typed as
   * `unknown` to keep this module free of contract imports; the one consumer
   * narrows it.
   */
  preview?: unknown;
}

declare global {
  interface Window {
    loop?: LoopDesktopBridge;
  }
}

export class LoopTransportError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = "LoopTransportError";
    this.method = method;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ConnectionState = "connecting" | "open" | "closed";

/**
 * Where `loop serve` is. Same origin is the shipped case — the page is served
 * by loop itself. `?rpc=` / `VITE_LOOP_RPC_URL` exist so `vp dev` on :5733 can
 * drive a `loop serve` on :5667.
 */
function resolveSocketUrl(): string {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const override = params.get("rpc") ?? (import.meta.env?.VITE_LOOP_RPC_URL as string | undefined);
  const token = params.get("token") ?? "";
  const base =
    override ??
    `${globalThis.location.protocol === "https:" ? "wss:" : "ws:"}//${globalThis.location.host}/ws`;
  if (!token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

class LoopSocket {
  #socket: WebSocket | null = null;
  #state: ConnectionState = "closed";
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: LoopEvent) => void>();
  #channelListeners = new Map<string, Set<(payload: unknown) => void>>();
  #stateListeners = new Set<(state: ConnectionState) => void>();
  #reconnectDelay = RECONNECT_MIN_MS;
  /** Calls made before the socket opens wait here rather than failing. */
  #openWaiters: Array<() => void> = [];

  get state(): ConnectionState {
    return this.#state;
  }

  connect(): void {
    if (this.#state !== "closed") return;
    this.#setState("connecting");
    const socket = new WebSocket(resolveSocketUrl());
    this.#socket = socket;
    socket.onopen = () => {
      this.#reconnectDelay = RECONNECT_MIN_MS;
      this.#setState("open");
      const waiters = this.#openWaiters;
      this.#openWaiters = [];
      for (const wake of waiters) wake();
    };
    socket.onmessage = (event) => this.#receive(String(event.data));
    socket.onclose = () => this.#handleClose();
    socket.onerror = () => socket.close();
  }

  onEvent(listener: (event: LoopEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A workspace channel (terminal output, git progress) from serve's host. */
  onChannel(channel: string, listener: (payload: unknown) => void): () => void {
    this.connect();
    let listeners = this.#channelListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.#channelListeners.set(channel, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async call(method: string, params: unknown): Promise<unknown> {
    this.connect();
    if (this.#state === "connecting") await this.#awaitOpen();
    const socket = this.#socket;
    if (!socket || this.#state !== "open") {
      throw new LoopTransportError(method, "not connected to loop");
    }
    const id = this.#nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new LoopTransportError(method, "timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  #awaitOpen(): Promise<void> {
    return new Promise((resolve) => {
      this.#openWaiters.push(resolve);
      setTimeout(resolve, REQUEST_TIMEOUT_MS);
    });
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }

  #receive(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "loop rpc error"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "session.event") {
      const event = message.params as LoopEvent;
      for (const listener of this.#listeners) listener(event);
      return;
    }
    if (message.method === "workspace.event") {
      const { channel, payload } = message.params as { channel: string; payload: unknown };
      for (const listener of this.#channelListeners.get(channel) ?? []) listener(payload);
    }
  }

  #handleClose(): void {
    this.#socket = null;
    this.#setState("closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("connection to loop closed"));
    }
    this.#pending.clear();
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    setTimeout(() => this.connect(), delay);
  }
}

const socket = new LoopSocket();

/**
 * The workspace over the socket: `loop serve` hosts the same handler table as
 * the desktop's utility process, so a browser gets files, terminals and git
 * too. Built on first use — a desktop shell never touches it.
 */
let socketWorkspace: WorkspaceBridges | null = null;
function browserWorkspace(): WorkspaceBridges {
  socketWorkspace ??= createWorkspaceBridges(
    (name, params) => socket.call(`workspace.${name}`, params ?? {}),
    (channel, listener) => socket.onChannel(channel, listener),
  );
  return socketWorkspace;
}

/** True when running inside the Electron shell rather than a browser. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && window.loop !== undefined;
}

/**
 * One loop JSON-RPC call.
 *
 * `cwd` identifies the project. Over `loop serve` it is a filter the server
 * applies; in Electron it selects which `loop rpc` process answers.
 */
export async function loopCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  cwd?: string,
): Promise<T> {
  const bridge = typeof window !== "undefined" ? window.loop : undefined;
  if (bridge) return (await bridge.call(method, params, cwd)) as T;
  // Over a socket the server holds every cwd, so the folder rides along as a
  // parameter instead of picking a process.
  const withCwd = cwd === undefined ? params : { cwd, ...params };
  return (await socket.call(method, withCwd)) as T;
}

/** Subscribe to loop's `session.event` notifications. Returns an unsubscribe. */
export function onLoopEvent(listener: (event: LoopEvent) => void): () => void {
  const bridge = typeof window !== "undefined" ? window.loop : undefined;
  if (bridge) return bridge.onEvent(listener);
  socket.connect();
  return socket.onEvent(listener);
}

/** Connection state, for the shells that show a disconnected banner. */
/**
 * Connection state, for the shells that show a disconnected banner — and for
 * the thread view, which re-attaches on every `open`.
 *
 * The desktop shell used to return a no-op here, which quietly disabled that
 * recovery: loop tracks event subscribers per TRANSPORT, so when main restarts
 * a crashed core the attach that belonged to the old one is gone and nothing
 * asks again. The thread went permanently silent — turns ran to completion with
 * the transcript frozen, and only a reload brought it back. main already
 * announced the restart; nothing was listening.
 *
 * Reported as `open`/`closed` rather than the socket's fuller lifecycle
 * because that is all the shell knows, and `open` is the only state the
 * re-attach path acts on.
 */
export function onLoopConnectionChange(listener: (state: ConnectionState) => void): () => void {
  const bridge = typeof window !== "undefined" ? window.loop : undefined;
  if (bridge) {
    // A preload that predates the status channel leaves this undefined; there
    // is nothing to report and nothing to recover from, as before.
    if (!bridge.onStatus) return () => {};
    return bridge.onStatus((running) => listener(running ? "open" : "closed"));
  }
  return socket.onStateChange(listener);
}

/**
 * One workspace bridge: the preload's in the desktop shell, the socket's in a
 * browser (where every one exists, because serve hosts the whole table).
 */
function workspaceBridge<K extends keyof WorkspaceBridges>(key: K): WorkspaceBridges[K] | null {
  // The preload's bridges are the same interfaces, each optional.
  if (isDesktopShell()) return (window.loop as Partial<WorkspaceBridges> | undefined)?.[key] ?? null;
  return browserWorkspace()[key];
}

/**
 * The filesystem bridge: Electron's preload in the desktop shell, serve's
 * workspace over the socket in a browser. Null only for a desktop shell whose
 * preload predates the capability.
 *
 * Null rather than a stub is deliberate: a caller has to decide what "no
 * filesystem here" means for its feature, and a stub that answers with an
 * empty directory would make an unavailable capability look like an empty
 * project.
 */
export function loopFilesystem(): LoopFilesystemBridge | null {
  return workspaceBridge("fs");
}

/** The PTY bridge. See loopFilesystem for where it comes from. */
export function loopPty(): LoopPtyBridge | null {
  return workspaceBridge("pty");
}

/** The git bridge. See loopFilesystem for where it comes from. */
export function loopGit(): LoopGitBridge | null {
  return workspaceBridge("git");
}

export function loopShell(): LoopShellBridge | null {
  return workspaceBridge("shell");
}

export function loopSourceControl(): LoopSourceControlBridge | null {
  return workspaceBridge("sourceControl");
}

/** The host window, or null in a browser — a tab has no traffic lights. */
export function loopWindow(): LoopWindowBridge | null {
  return (typeof window !== "undefined" ? window.loop?.window : undefined) ?? null;
}
