/**
 * The workspace bridges — files, terminals, git, shell, source control — for
 * a shell that reaches the workspace by message rather than through Electron's
 * preload.
 *
 * `loop serve` hosts the same handler table the desktop's utility process does
 * (core's `workspace/`), so this only has to say how each bridge method maps
 * onto a handler name and its params. The params are the preload's, key for
 * key: both ends are the one table.
 */
import type {
  GitActionProgressMessage,
  LoopFilesystemBridge,
  LoopGitBridge,
  LoopPtyBridge,
  LoopShellBridge,
  LoopSourceControlBridge,
  TerminalOutput,
} from "./transport";

/** Run one workspace handler (`fs.list`, `git.status`, …) and return its result. */
export type WorkspaceCall = (name: string, params?: Record<string, unknown>) => Promise<unknown>;
/** Listen on one of the host's channels; returns an unsubscribe. */
export type WorkspaceSubscribe = (channel: string, listener: (payload: unknown) => void) => () => void;

/** The host's channels — core's HOST_CHANNELS, which this bundle cannot import. */
export const WORKSPACE_CHANNELS = {
  terminal: "loop:terminal",
  gitAction: "loop:gitAction",
} as const;

export interface WorkspaceBridges {
  readonly fs: LoopFilesystemBridge;
  readonly pty: LoopPtyBridge;
  readonly git: LoopGitBridge;
  readonly shell: LoopShellBridge;
  readonly sourceControl: LoopSourceControlBridge;
}

export function createWorkspaceBridges(call: WorkspaceCall, on: WorkspaceSubscribe): WorkspaceBridges {
  // Each bridge method's result is whatever its handler returns, so the
  // casts below only restate the bridge interface's own return types.
  const ask = <T>(name: string, params?: Record<string, unknown>) => call(name, params) as Promise<T>;

  return {
    fs: {
      list: (cwd) => ask("fs.list", { cwd }),
      read: (cwd, relativePath) => ask("fs.read", { cwd, relativePath }),
      write: (cwd, relativePath, contents) => ask("fs.write", { cwd, relativePath, contents }),
      readAsset: async (absolutePath) => {
        // Bytes travel as base64 (`{ $bytes }`, see serve's workspace replies)
        // rather than JSON's one-key-per-byte rendering of a Uint8Array.
        const result = await ask<
          { ok: true; data: { $bytes: string }; mimeType: string } | { ok: false; failure: string }
        >("fs.readAsset", { absolutePath });
        if (!result.ok) return result;
        const binary = atob(result.data.$bytes);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
        return { ok: true, data, mimeType: result.mimeType };
      },
      browse: (partialPath, cwd) => ask("fs.browse", { partialPath, cwd }),
      createDirectory: (path) => ask("fs.createDirectory", { path }),
    },
    pty: {
      open: (input) => ask("pty.open", input),
      snapshot: (threadId, terminalId) => ask("pty.snapshot", { threadId, terminalId }),
      list: () => ask("pty.list"),
      write: (threadId, terminalId, data) => ask("pty.write", { threadId, terminalId, data }),
      resize: (threadId, terminalId, cols, rows) => ask("pty.resize", { threadId, terminalId, cols, rows }),
      clear: (threadId, terminalId) => ask("pty.clear", { threadId, terminalId }),
      close: (threadId, terminalId) => ask("pty.close", { threadId, terminalId }),
      onOutput: (listener) => on(WORKSPACE_CHANNELS.terminal, (payload) => listener(payload as TerminalOutput)),
    },
    git: {
      refs: (cwd) => ask("git.refs", { cwd }),
      status: (cwd) => ask("git.status", { cwd }),
      init: (cwd) => ask("git.init", { cwd }),
      diffPreview: (cwd, options) => ask("git.diffPreview", { cwd, ...options }),
      runStackedAction: (input) => ask("git.runStackedAction", input),
      discover: () => ask("git.discover"),
      stage: (cwd, paths) => ask("git.stage", { cwd, paths }),
      unstage: (cwd, paths) => ask("git.unstage", { cwd, paths }),
      discard: (cwd, input) => ask("git.discard", { cwd, ...input }),
      stageContent: (cwd, path, content) => ask("git.stageContent", { cwd, path, content }),
      fileAtRevision: (cwd, revision, path) => ask("git.fileAtRevision", { cwd, revision, path }),
      conflictStages: (cwd, path) => ask("git.conflictStages", { cwd, path }),
      onActionProgress: (listener) =>
        on(WORKSPACE_CHANNELS.gitAction, (payload) => listener(payload as GitActionProgressMessage)),
    },
    shell: {
      which: (commands) => ask("shell.which", { commands }),
      launch: (command, args, target) => ask("shell.launch", { command, args, target }),
    },
    sourceControl: {
      lookup: (repository) => ask("sc.lookup", { repository }),
      clone: (input) => ask("sc.clone", input),
      publish: (input) => ask("sc.publish", input),
    },
  };
}
