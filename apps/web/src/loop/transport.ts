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
  // Read defensively: this module also runs outside Vite (the mobile app).
  const env = (import.meta as { env?: { VITE_LOOP_RPC_URL?: string } }).env;
  const override = params.get("rpc") ?? env?.VITE_LOOP_RPC_URL;
  const token = params.get("token") ?? "";
  const base =
    override ??
    `${globalThis.location.protocol === "https:" ? "wss:" : "ws:"}//${globalThis.location.host}/ws`;
  if (!token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

class LoopSocket {
  readonly #resolveUrl: () => string;
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
  /** Set by `close()`: a host the app forgot must not keep redialing. */
  #closed = false;
  readonly #reconnect: boolean;

  /** A resolver rather than a string so the same-origin URL is read when dialing. */
  constructor(resolveUrl: () => string, options: { reconnect?: boolean } = {}) {
    this.#resolveUrl = resolveUrl;
    this.#reconnect = options.reconnect ?? true;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  connect(): void {
    if (this.#closed || this.#state !== "closed") return;
    this.#setState("connecting");
    const socket = new WebSocket(this.#resolveUrl());
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
    // Host-wide: a session somewhere on this host started or ended a turn,
    // appeared, was renamed or went away — sent to every client, subscribed
    // to that session or not. Delivered through the same listeners as a
    // `session-status` part with no seq (0), so it never moves a resume point.
    if (message.method === "session.status") {
      const status = message.params as { sessionId?: string } | undefined;
      if (typeof status?.sessionId !== "string") return;
      const event: LoopEvent = {
        sessionId: status.sessionId,
        seq: 0,
        part: { type: "session-status", data: status },
      };
      for (const listener of this.#listeners) listener(event);
      return;
    }
    if (message.method === "workspace.event") {
      const { channel, payload } = message.params as { channel: string; payload: unknown };
      for (const listener of this.#channelListeners.get(channel) ?? []) listener(payload);
    }
  }

  /** Hang up for good: no reconnect, and every waiting call fails. */
  close(): void {
    this.#closed = true;
    this.#socket?.close();
  }

  #handleClose(): void {
    this.#socket = null;
    this.#setState("closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("connection to loop closed"));
    }
    this.#pending.clear();
    // A one-use URL (a paired host's ticket) cannot be redialed: the owner
    // learns of the close and connects again with a fresh one.
    if (!this.#reconnect) this.#closed = true;
    if (this.#closed) return;
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    setTimeout(() => this.connect(), delay);
  }
}

/**
 * One loop host: a machine running `loop serve` (or, in the desktop shell, the
 * app's own `loop rpc` children).
 *
 * The handlers act on a host rather than on "the" connection so one app can
 * hold several at once — the mobile app's host list, or a browser tab with a
 * second machine added. Everything below this interface is per host: its
 * socket, its event stream, its workspace (files, terminals, git live on the
 * host's disk, not the client's).
 */
export interface LoopHost {
  /** Stable for the host's life; keys per-host state held outside it. */
  readonly id: string;
  /**
   * One loop JSON-RPC call. `cwd` identifies the project: over a socket it is
   * a parameter the server applies; in Electron it selects which `loop rpc`
   * process answers.
   */
  call<T = unknown>(method: string, params?: Record<string, unknown>, cwd?: string): Promise<T>;
  /** loop's `session.event` notifications. Returns an unsubscribe. */
  onEvent(listener: (event: LoopEvent) => void): () => void;
  /** See `onLoopConnectionChange`. */
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
  filesystem(): LoopFilesystemBridge | null;
  pty(): LoopPtyBridge | null;
  git(): LoopGitBridge | null;
  shell(): LoopShellBridge | null;
  sourceControl(): LoopSourceControlBridge | null;
}

export type LoopConnectionState = ConnectionState;

/**
 * A host reached over a WebSocket — `loop serve`'s `/ws?token=…`. The URL
 * carries the token; nothing is dialed until the first call or subscription.
 */
export function createSocketHost(
  id: string,
  url: string | (() => string),
  options: {
    /**
     * Redial on its own after a drop. Off for a URL that works once — a paired
     * host's `?wsTicket=` — whose owner must mint a new one instead (see
     * LoopHostResolver in runtime/rpc/session.ts).
     */
    reconnect?: boolean;
  } = {},
): LoopHost & {
  close(): void;
} {
  const socket = new LoopSocket(typeof url === "string" ? () => url : url, options);
  let workspace: WorkspaceBridges | null = null;
  // serve hosts the same workspace handler table as the desktop's utility
  // process, so every bridge exists. Built on first use.
  const bridges = (): WorkspaceBridges =>
    (workspace ??= createWorkspaceBridges(
      (name, params) => socket.call(`workspace.${name}`, params ?? {}),
      (channel, listener) => socket.onChannel(channel, listener),
    ));
  return {
    id,
    async call<T>(method: string, params: Record<string, unknown> = {}, cwd?: string) {
      // The server holds every cwd, so the folder rides along as a parameter
      // instead of picking a process.
      const withCwd = cwd === undefined ? params : { cwd, ...params };
      return (await socket.call(method, withCwd)) as T;
    },
    onEvent(listener) {
      socket.connect();
      return socket.onEvent(listener);
    },
    onConnectionChange: (listener) => socket.onStateChange(listener),
    filesystem: () => bridges().fs,
    pty: () => bridges().pty,
    git: () => bridges().git,
    shell: () => bridges().shell,
    sourceControl: () => bridges().sourceControl,
    close: () => socket.close(),
  };
}

/** True when running inside the Electron shell rather than a browser. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && window.loop !== undefined;
}

/** The preload's bridge, read at call time: tests (and a reloaded preload) swap it. */
function desktopBridge(): LoopDesktopBridge | undefined {
  return typeof window !== "undefined" ? window.loop : undefined;
}

/** Where `loop serve` is, for a page served by it. */
let sameOriginHost: ReturnType<typeof createSocketHost> | null = null;
function servingHost(): LoopHost {
  // No page, no page host: a native shell (the mobile app) has no
  // `location` to dial, and every host it talks to is one it was given.
  if (globalThis.location === undefined) return noHost;
  return (sameOriginHost ??= createSocketHost("primary", resolveSocketUrl));
}

/**
 * The default host of a shell that has none. Calls fail; subscriptions are
 * inert rather than throwing, because module-level code subscribes on load.
 */
const noHost: LoopHost = {
  id: "none",
  call: (method) => Promise.reject(new LoopTransportError(method, "this app has no default loop host")),
  onEvent: () => () => {},
  onConnectionChange: () => () => {},
  filesystem: () => null,
  pty: () => null,
  git: () => null,
  shell: () => null,
  sourceControl: () => null,
};

/**
 * The host this page belongs to: the desktop's own loop in Electron, the
 * `loop serve` that served the page in a browser.
 *
 * Decided per call, not once, because the preload bridge is what decides and
 * it can appear after this module loads (and tests install their own).
 */
export const defaultLoopHost: LoopHost = {
  id: "primary",
  async call<T>(method: string, params: Record<string, unknown> = {}, cwd?: string) {
    const bridge = desktopBridge();
    if (bridge) return (await bridge.call(method, params, cwd)) as T;
    return servingHost().call<T>(method, params, cwd);
  },
  onEvent(listener) {
    const bridge = desktopBridge();
    if (bridge) return bridge.onEvent(listener);
    return servingHost().onEvent(listener);
  },
  onConnectionChange(listener) {
    const bridge = desktopBridge();
    if (bridge) {
      // A preload that predates the status channel leaves this undefined; there
      // is nothing to report and nothing to recover from, as before.
      if (!bridge.onStatus) return () => {};
      return bridge.onStatus((running) => listener(running ? "open" : "closed"));
    }
    return servingHost().onConnectionChange(listener);
  },
  filesystem: () => (isDesktopShell() ? preloadBridge("fs") : servingHost().filesystem()),
  pty: () => (isDesktopShell() ? preloadBridge("pty") : servingHost().pty()),
  git: () => (isDesktopShell() ? preloadBridge("git") : servingHost().git()),
  shell: () => (isDesktopShell() ? preloadBridge("shell") : servingHost().shell()),
  sourceControl: () =>
    isDesktopShell() ? preloadBridge("sourceControl") : servingHost().sourceControl(),
};

/** One of the preload's workspace bridges: the same interfaces, each optional. */
function preloadBridge<K extends keyof WorkspaceBridges>(key: K): WorkspaceBridges[K] | null {
  return (window.loop as Partial<WorkspaceBridges> | undefined)?.[key] ?? null;
}

/** One JSON-RPC call to the default host. See `LoopHost.call`. */
export async function loopCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  cwd?: string,
): Promise<T> {
  return defaultLoopHost.call<T>(method, params, cwd);
}

/** Subscribe to the default host's `session.event` notifications. Returns an unsubscribe. */
export function onLoopEvent(listener: (event: LoopEvent) => void): () => void {
  return defaultLoopHost.onEvent(listener);
}

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
  return defaultLoopHost.onConnectionChange(listener);
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
  return defaultLoopHost.filesystem();
}

/** The PTY bridge. See loopFilesystem for where it comes from. */
export function loopPty(): LoopPtyBridge | null {
  return defaultLoopHost.pty();
}

/** The git bridge. See loopFilesystem for where it comes from. */
export function loopGit(): LoopGitBridge | null {
  return defaultLoopHost.git();
}

export function loopShell(): LoopShellBridge | null {
  return defaultLoopHost.shell();
}

export function loopSourceControl(): LoopSourceControlBridge | null {
  return defaultLoopHost.sourceControl();
}

/** The host window, or null in a browser — a tab has no traffic lights. */
export function loopWindow(): LoopWindowBridge | null {
  return (typeof window !== "undefined" ? window.loop?.window : undefined) ?? null;
}
