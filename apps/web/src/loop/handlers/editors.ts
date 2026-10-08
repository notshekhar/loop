/**
 * Detecting and launching editors.
 *
 * Two halves of the same gap. `shell.openInEditor` failed as unsupported, and
 * the server config reported `availableEditors: []` unconditionally — so even
 * once launching worked, the "Open in…" menu would still have been empty,
 * because nothing ever detected what was installed. Both live here.
 *
 * The editor table itself stays in the contracts (`EDITORS`), which is also
 * what the UI draws its labels from. The shell only answers "is this command on
 * PATH" and "run it", so there is exactly one list.
 */
import {
  EDITORS,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  type EditorId,
} from "@loop/contracts";
import * as Effect from "effect/Effect";

import { defaultLoopHost, type LoopHost } from "../transport.ts";

/** Every command any editor might be installed as, asked for in one round trip. */
const ALL_COMMANDS = [...new Set(EDITORS.flatMap((editor) => editor.commands ?? []))];

/**
 * Detection is cached: the server config is rebuilt on a 30s poll, and probing
 * two dozen commands that often would spawn ~2,900 processes an hour to answer
 * a question whose answer changes when someone installs an editor. The TTL is
 * short enough that a fresh install shows up without a restart.
 */
const DETECT_TTL_MS = 5 * 60_000;
/** Per host: each machine has its own editors installed. */
const cached = new Map<string, { at: number; editors: readonly EditorId[] }>();

/** Forget the cache — for tests, and for an explicit rescan. */
export function resetEditorDetection(): void {
  cached.clear();
}

/**
 * Which editors are installed.
 *
 * Called while building the server config, so it must never throw: a failed
 * probe means "no editors detected", which shows an empty menu rather than
 * taking down the whole config the rest of the app is waiting on.
 */
export const detectEditors = Effect.fnUntraced(function* (host: LoopHost = defaultLoopHost) {
  const shell = host.shell();
  // A browser cannot launch a local editor, so offering one would be a lie.
  if (!shell) return [] as readonly EditorId[];

  const hit = cached.get(host.id);
  if (hit && Date.now() - hit.at < DETECT_TTL_MS) return hit.editors;

  const found = yield* Effect.promise(() =>
    // Swallowed here rather than as an Effect failure: a probe that could not
    // run means "nothing detected", and the server config must still build.
    shell.which(ALL_COMMANDS).catch(() => ({}) as Record<string, string | null>),
  );

  const editors = EDITORS.flatMap((editor) => {
    // The file manager is always there — it is the OS, not an install.
    if (editor.commands === null) return [editor.id as EditorId];
    return editor.commands.some((command) => found[command]) ? [editor.id as EditorId] : [];
  });
  cached.set(host.id, { at: Date.now(), editors });
  return editors;
});

/**
 * Open `cwd` — a file or a folder — in `editor`.
 *
 * The contract carries no line number, so every launch style collapses to
 * "pass the path": `--goto` and `--line` only differ once there is a line to
 * point at. Pretending otherwise would add flags for information we do not have.
 */
export const openInEditor = Effect.fnUntraced(function* (
  input: {
    readonly cwd: string;
    readonly editor: EditorId;
  },
  host: LoopHost = defaultLoopHost,
) {
  const definition = EDITORS.find((entry) => entry.id === input.editor);
  if (!definition) {
    return yield* Effect.fail(new ExternalLauncherUnknownEditorError({ editor: input.editor }));
  }

  const shell = host.shell();
  if (!shell) {
    return yield* Effect.fail(
      new ExternalLauncherCommandNotFoundError({
        editor: input.editor,
        command: definition.commands?.[0] ?? "open",
      }),
    );
  }

  let command: string | null = null;
  if (definition.commands !== null) {
    const found = yield* Effect.promise(() => shell.which(definition.commands));
    // The first alternative that exists — `zed` before `zeditor`.
    command = definition.commands.find((name) => found[name]) ?? null;
    if (!command) {
      return yield* Effect.fail(
        new ExternalLauncherCommandNotFoundError({
          editor: input.editor,
          command: definition.commands[0],
        }),
      );
    }
  }

  // Only some editors carry baseArgs (Kiro's `ide`), so the union has to be
  // narrowed rather than read through.
  const baseArgs = "baseArgs" in definition ? (definition.baseArgs as readonly string[]) : [];
  const args = [...baseArgs, input.cwd];
  const result = yield* Effect.promise(() => shell.launch(command, args, input.cwd));
  if (!result.ok) {
    return yield* Effect.fail(
      new ExternalLauncherEditorSpawnError({
        editor: input.editor,
        target: input.cwd,
        command: command ?? "open",
        args,
        cause: result.error,
      }),
    );
  }
  return undefined;
});
