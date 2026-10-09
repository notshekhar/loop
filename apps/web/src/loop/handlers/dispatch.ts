/**
 * Commands from the UI, executed against loop.
 *
 * The contract's command union has 20 members; loop can honestly serve the few
 * that correspond to something it does. The rest are rejected rather than
 * silently accepted — a command that returns a sequence number but changes
 * nothing is worse than one that visibly fails.
 *
 * The id problem, and why `bindings` exists: `thread.create` carries a
 * **client-chosen** `threadId`, but loop mints its own ULID in
 * `session.create`. Everywhere else a thread id IS a loop session id (that is
 * what the shell hands out), so the table maps between the two — and it
 * outlives the process, because the client id is in the URL.
 */
import type { ClientOrchestrationCommand } from "@loop/contracts";
import * as Effect from "effect/Effect";

import { forgetAddedProject, rememberAddedProject } from "./addedProjects.ts";
import { fromInstanceId } from "./ids.ts";
import {
  abandonLiveTurn,
  beginLiveTurn,
  clearLiveAsk,
  notifyThreadChanged,
  onLiveTurnChange,
  readLiveTurn,
} from "./liveTurn.ts";
import { useQueuedTurnsStore, type QueuedTurn } from "../../queuedTurnsStore.ts";
import { defaultLoopHost, type LoopHost } from "../transport.ts";

/**
 * client threadId -> loop sessionId, for threads this client created.
 *
 * **Persisted, and it has to be.** The composer mints its own thread id before
 * loop exists as a session, so a thread created in the app lives at
 * `/primary/<uuid>` while loop knows it by a ULID. Held only in memory, that
 * mapping died with the process: after a restart the shell reported loop's
 * ULID, the open URL matched nothing, and the thread page came up empty — the
 * terminal silently doing nothing was just the first symptom.
 *
 * Bounded because it is unbounded otherwise: one entry per thread ever created
 * in this app, forever. The oldest are dropped first, and losing one only
 * costs a stale URL, which is where this started.
 */
const BINDINGS_STORAGE_KEY = "loop:thread-bindings";
const MAX_BINDINGS = 500;

function loadBindings(): Map<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(BINDINGS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    return new Map(
      parsed.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string",
      ),
    );
  } catch {
    // A malformed or unavailable store must not stop the app from starting.
    return new Map();
  }
}

const bindings = loadBindings();

function saveBindings(): void {
  try {
    while (bindings.size > MAX_BINDINGS) {
      const oldest = bindings.keys().next();
      if (oldest.done) break;
      bindings.delete(oldest.value);
    }
    globalThis.localStorage?.setItem(BINDINGS_STORAGE_KEY, JSON.stringify([...bindings]));
  } catch {
    // Storage full or unavailable: the mapping still works this run.
  }
}

/**
 * The per-turn options a thread last ran with (thinking level, agent).
 *
 * loop does not persist these — `session.send` takes `thinking` and `agent`
 * per turn and stores neither, so `session.list`/`session.history` cannot
 * report them back. Without this memory the thread's `modelSelection` comes
 * back with NO options once the first turn creates it, and the composer, which
 * reads the thread's selection in preference to the draft's, drops the effort
 * the user had chosen. Symptom: the first message of a session silently resets
 * thinking, and only a second, explicit pick sticks.
 *
 * Same storage discipline as `bindings` — persisted so a restart does not
 * reset every open thread's effort back to the default.
 */
const TURN_OPTIONS_STORAGE_KEY = "loop:thread-turn-options";
type TurnOption = { readonly id: string; readonly value: string };

function loadTurnOptions(): Map<string, TurnOption[]> {
  try {
    const raw = globalThis.localStorage?.getItem(TURN_OPTIONS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    return new Map(
      parsed.filter(
        (entry): entry is [string, TurnOption[]] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          Array.isArray(entry[1]),
      ),
    );
  } catch {
    return new Map();
  }
}

const turnOptions = loadTurnOptions();

function rememberTurnOptions(threadId: string, options: readonly TurnOption[] | undefined): void {
  // An empty selection means "use loop's own defaults" — recording it would
  // pin the thread to whatever the defaults were at that moment.
  if (!options || options.length === 0) return;
  turnOptions.set(threadId, [...options]);
  try {
    while (turnOptions.size > MAX_BINDINGS) {
      const oldest = turnOptions.keys().next();
      if (oldest.done) break;
      turnOptions.delete(oldest.value);
    }
    globalThis.localStorage?.setItem(TURN_OPTIONS_STORAGE_KEY, JSON.stringify([...turnOptions]));
  } catch {
    // Storage full or unavailable: the memory still works this run.
  }
}

/** What a thread's `modelSelection.options` should report. */
export function turnOptionsFor(threadId: string): readonly TurnOption[] {
  return turnOptions.get(threadId) ?? [];
}

/** client projectId -> folder, for a project added in this session. */
const projectFolders = new Map<string, string>();

/** Everything a `thread.create` needs to remember until the first turn. */
interface PendingThread {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
}
const pending = new Map<string, PendingThread>();


/** The loop session behind a thread id. Identity for anything from the shell. */
export function loopSessionIdFor(threadId: string): string {
  return bindings.get(threadId) ?? threadId;
}

/** Drop a deleted thread's id bindings so nothing points at a gone session. */
export function forgetThread(threadId: string): void {
  if (bindings.delete(threadId)) saveBindings();
  pending.delete(threadId);
}

/**
 * The reverse: the id the client knows a session by.
 *
 * This is what lets a draft finish becoming a thread. The draft route watches
 * the shell for a thread whose id matches the draft's own client-generated id,
 * and navigates when it appears. loop names the session something else
 * entirely, so a shell that reported loop's id would never satisfy that match
 * — the composer would sit on "Working" forever while the turn completed
 * perfectly well underneath.
 */
export function clientThreadIdFor(loopSessionId: string): string {
  for (const [threadId, sessionId] of bindings) {
    if (sessionId === loopSessionId) return threadId;
  }
  return loopSessionId;
}

/**
 * True while a thread exists only in the UI.
 *
 * The composer creates a draft as soon as it opens, with a client-generated
 * id, and loop is told nothing until the first turn. Anything that would ask
 * loop about such a thread has to check here first — loop answers "Unknown
 * sessionId", which is correct of it and useless to us.
 */
export function isDraftThread(threadId: string): boolean {
  return !bindings.has(threadId) && pending.has(threadId);
}

/** What `thread.create` recorded for a draft, if anything. */
export function draftIntent(threadId: string): PendingThread | undefined {
  return pending.get(threadId);
}

/**
 * The id the client gave the message it just sent.
 *
 * The client renders a user message optimistically the moment you hit send,
 * keyed by the `messageId` it minted. loop's transcript knows nothing of that
 * id, so a snapshot built from the transcript introduces a SECOND message with
 * the same text and a different id — the send appears twice. Remembering the
 * client's id lets the transcript reuse it, and the two collapse into one.
 *
 * Only the latest per session is kept: it exists to reconcile the message
 * still in flight, and older ones are already settled in the transcript.
 */
const lastUserMessage = new Map<string, { messageId: string; text: string }>();

export function recentUserMessageId(sessionId: string, text: string): string | undefined {
  const recent = lastUserMessage.get(sessionId);
  return recent && recent.text === text ? recent.messageId : undefined;
}

export class UnsupportedCommandError extends Error {
  constructor(type: string) {
    super(`loop does not support the ${type} command`);
    this.name = "UnsupportedCommandError";
  }
}

/**
 * Where a message typed mid-stream goes.
 *
 * loop takes one turn at a time and says so: `session.send` against a busy
 * session throws `already has a turn running (cancel it first)`. Nothing above
 * this file handled that, so hitting Enter mid-stream put an error on the
 * thread and handed the text back to the composer — the send simply did not
 * happen. There is nowhere else to fix it: loop has no queue of its own, and
 * the composer cannot know a send will be refused until it has been.
 *
 * The queue itself lives in `queuedTurnsStore`, not here, because it is
 * something the user looks at and takes back — the strip above the composer is
 * rendered straight off it. This file owns only the *policy*: when to queue,
 * when to drain, and what a refusal on the way out means.
 */

/** Sessions whose queue is being drained, so a burst of events cannot double-send. */
const draining = new Set<string>();

let watchingTurnEnds = false;

/**
 * loop's own answer to "is this session busy", and the only one worth trusting.
 *
 * The tempting shortcut is to ask the live turn in `liveTurn.ts` whether it is
 * still running and queue without trying. It is wrong in the direction that
 * hurts: that flag is only closed by a `finish`/`error` event reaching this
 * client, so a turn that ended while the app was reloading — or one this
 * client never dispatched — leaves it stuck at `true` forever, and every
 * message after it would queue behind a turn that finished hours ago. Asking
 * loop costs one refused call and cannot get stuck.
 */
function isTurnAlreadyRunning(error: unknown): boolean {
  return /already has a turn running/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function queueTurn(turn: QueuedTurn): void {
  watchTurnEnds();
  useQueuedTurnsStore.getState().enqueue(turn);
}

function discardQueuedTurns(sessionId: string): void {
  useQueuedTurnsStore.getState().clearSession(sessionId);
}

/**
 * Send a queued message NOW, interrupting whatever is running.
 *
 * The terminal has always had this: Esc stops the turn, and what you typed
 * while it worked goes next. The app could only wait — a message sat behind a
 * turn you had already decided was going the wrong way, and the only way to
 * act on that was Stop, which threw the message away with it.
 *
 * Taken out of the queue FIRST, deliberately: `thread.turn.interrupt`
 * discards everything still waiting on the session, so a message left in the
 * queue while we cancel would be destroyed by the very cancel meant to make
 * room for it.
 *
 * A failed send puts it back at the front rather than losing it — the turn may
 * not have finished cancelling yet, and the drain that runs on the real end
 * will pick it up.
 */
export async function sendQueuedTurnNow(id: string): Promise<void> {
  const turn = useQueuedTurnsStore.getState().take(id);
  if (!turn) return;
  try {
    await turn.interrupt();
    await turn.send();
  } catch (error) {
    useQueuedTurnsStore.getState().requeueFirst(turn);
    console.warn("A queued message could not be sent early.", {
      operation: "send-queued-turn-now",
      sessionId: turn.sessionId,
      error,
    });
  }
}

function watchTurnEnds(): void {
  if (watchingTurnEnds) return;
  watchingTurnEnds = true;
  onLiveTurnChange((sessionId) => {
    void drainQueuedTurns(sessionId);
  });
}

/**
 * Send the next queued turn once the running one has ended.
 *
 * One per drain, not the whole queue: the send starts a new turn, so the rest
 * have to wait for its own end — which arrives here as another change event.
 *
 * The live turn's running flag gates this rather than deciding it. Every
 * change event would otherwise be a refused `session.send` at delta rate, and
 * a flag that is stale in the stuck-at-running direction costs nothing here:
 * the turn whose refusal put this message on the queue is the one whose end
 * clears it.
 *
 * A refusal on the way out means the turn had not really ended, so the message
 * goes back at the front and waits for the next one. Any other failure drops
 * it with a warning — retrying it after every future turn would be worse than
 * losing it once, loudly.
 */
async function drainQueuedTurns(sessionId: string): Promise<void> {
  if (draining.has(sessionId)) return;
  if (readLiveTurn(sessionId)?.running === true) return;

  const queued = useQueuedTurnsStore.getState().takeNext(sessionId);
  if (!queued) return;

  draining.add(sessionId);
  try {
    await queued.send();
  } catch (error) {
    if (isTurnAlreadyRunning(error)) {
      useQueuedTurnsStore.getState().requeueFirst(queued);
      return;
    }
    console.warn("A queued message could not be sent.", {
      operation: "drain-queued-turn",
      sessionId,
      error,
    });
  } finally {
    draining.delete(sessionId);
  }
}

/**
 * loop creates a session lazily.
 *
 * `thread.create` is dispatched when the composer opens a draft, long before
 * the user commits to anything — creating a loop session there would litter
 * the sidebar with empty sessions every time someone clicked "New thread". So
 * the intent is recorded and the session is only minted on the first turn.
 */
async function ensureSession(threadId: string, host: LoopHost): Promise<string> {
  const bound = bindings.get(threadId);
  if (bound) return bound;

  // No recorded intent means this thread did not come from `thread.create` —
  // it came from the shell, where a thread id IS a loop session id. Creating
  // one here would fork the conversation into a brand new session and send
  // the turn somewhere the user is not looking.
  const intent = pending.get(threadId);
  if (!intent) return threadId;

  const created = await host.call<{ sessionId: string }>(
    "session.create",
    { cwd: intent.cwd, provider: intent.provider, model: intent.model },
    intent.cwd,
  );
  bindings.set(threadId, created.sessionId);
  saveBindings();
  pending.delete(threadId);
  return created.sessionId;
}

/** loop's thinking levels, in `session.send`'s `thinking` parameter. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The effort the composer picked, as loop's thinking level.
 *
 * The two vocabularies nearly agree — the model picker's reasoning-effort
 * option is `minimal`/`low`/`medium`/`high`, and loop adds `off` and `xhigh`
 * (`/thinking` in the terminal). Anything unrecognised is left out entirely so
 * loop falls back to the `thinkingLevel` setting rather than being pinned to a
 * guess.
 */
export function thinkingLevelOf(
  options: readonly { readonly id?: string; readonly value?: unknown }[] | undefined,
): ThinkingLevel | undefined {
  const effort = options?.find((option) => option.id === "reasoningEffort")?.value;
  if (typeof effort !== "string") return undefined;
  const normalized = effort.toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as ThinkingLevel)
    : undefined;
}

/**
 * The agent this turn should run under, if the composer picked one.
 *
 * loop's `/<agent> <message>` is a ONE-SHOT: that message runs under the
 * agent's prompt and the session's own agent is untouched. There is no `agent`
 * field on the contract's turn command, so it rides the model selection's
 * options — the same slot reasoning effort uses, and like it, a per-turn
 * choice rather than session state.
 */
export function agentOptionOf(
  options: readonly { readonly id?: string; readonly value?: unknown }[] | undefined,
): string | undefined {
  const agent = options?.find((option) => option.id === "agent")?.value;
  if (typeof agent !== "string") return undefined;
  const trimmed = agent.trim();
  // "default" is loop's name for the built-in persona, which is what sending
  // nothing already means — so it is not worth naming on the wire.
  return trimmed === "" || trimmed === "default" ? undefined : trimmed;
}

type TurnStartCommand = Extract<ClientOrchestrationCommand, { readonly type: "thread.turn.start" }>;

/**
 * The composer's attachments, in the shape `session.send` takes.
 *
 * **This is where attaching was silently broken.** The composer stages images,
 * renders their thumbnails and puts them on the command as data URLs — and the
 * turn was sent with `input` alone, so every attachment was dropped at this
 * seam. The model was answering a message it could not see the picture in,
 * which is indistinguishable from it ignoring the picture.
 *
 * loop takes `{data, mediaType}` with `data` base64. The RPC server writes each
 * to a temp file and appends the same `[image:<path>]` sentinel paste and drag
 * produce in the terminal, so the whole existing pipeline — extraction,
 * per-model modality filtering, transcript, replay — applies unchanged
 * (`packages/core/src/rpc/server.ts`, `writeAttachmentPayloads`).
 *
 * A data URL is `data:<mime>;base64,<payload>`; anything without the comma is
 * not one and is dropped rather than sent as garbage bytes.
 */
function attachmentPayloads(
  attachments: TurnStartCommand["message"]["attachments"],
): ReadonlyArray<{ readonly data: string; readonly mediaType: string }> {
  // Optional in the contract (`Schema.optional`), so a composer that sends no
  // attachments sends the field not at all — and reading `.flatMap` off that
  // threw before the turn was ever dispatched, which the UI showed as a
  // message that simply never went anywhere.
  return (attachments ?? []).flatMap((attachment) => {
    const separator = attachment.dataUrl.indexOf(",");
    if (separator < 0) return [];
    return [{ data: attachment.dataUrl.slice(separator + 1), mediaType: attachment.mimeType }];
  });
}

/**
 * One turn, handed to loop.
 *
 * Split out of the command handler so a queued message runs exactly the same
 * path a fresh one does — the id bookkeeping below is not optional, and a
 * second copy of it in the drain would be the kind of thing that stays right
 * for a month.
 */
async function sendTurn(
  sessionId: string,
  message: TurnStartCommand["message"],
  selection: TurnStartCommand["modelSelection"],
  host: LoopHost,
): Promise<void> {
  // Begin the live turn BEFORE sending: loop can emit its first delta while
  // `session.send` is still in flight, and an event that arrives before the
  // buffer exists would be dropped. Both are therefore written speculatively,
  // and both are put back below if loop turns the send down.
  const displacedMessage = lastUserMessage.get(sessionId);
  lastUserMessage.set(sessionId, {
    messageId: message.messageId,
    text: message.text,
  });
  const speculativeTurn = beginLiveTurn(sessionId, host);
  // `model` carries the provider (`xai/composer-2.5`) — loop has no separate
  // provider parameter, and runTurn resolves it from the id, so this is also
  // how a provider switch reaches loop.
  const thinking = thinkingLevelOf(selection?.options);
  const agent = agentOptionOf(selection?.options);
  // loop stores neither, so the thread would report a selection with no
  // options and the composer would reset the picker on the next render.
  // Keyed by loop's session id, not the client thread id: an app-created
  // thread lives at a client-minted uuid while loop knows a ULID, and the
  // persisted-thread path only ever has the ULID.
  rememberTurnOptions(sessionId, selection?.options as readonly TurnOption[] | undefined);
  const images = attachmentPayloads(message.attachments);
  try {
    await host.call("session.send", {
      sessionId,
      input: message.text,
      ...(images.length === 0 ? {} : { images }),
      ...(selection === undefined ? {} : { model: selection.model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(agent === undefined ? {} : { agent }),
    });
  } catch (error) {
    // Refused, so no turn started here — and whatever the speculative writes
    // above displaced belongs to a turn that is still running. Left alone,
    // the reply on screen would blank out and pick up mid-sentence.
    if (displacedMessage === undefined) lastUserMessage.delete(sessionId);
    else lastUserMessage.set(sessionId, displacedMessage);
    abandonLiveTurn(sessionId, speculativeTurn);
    throw error;
  }
}

/**
 * The folder a project id means.
 *
 * A project id from the shell IS a folder, so most ids need no translation.
 * The command palette is the exception: it mints a fresh ULID for a project
 * before anything knows where it lives, so `project.create` records the folder
 * against that id and everything downstream asks here. The mapping only has to
 * outlive the draft — once the first turn creates a session, the shell reports
 * the project under its cwd and the ULID is never seen again.
 */
function projectFolderFor(projectId: string): string {
  return projectFolders.get(projectId) ?? projectId;
}

/**
 * Where a `project.create` actually points.
 *
 * The typed path is resolved through the shell rather than trusted, because
 * two things silently accept nonsense: `~` is a shell convention that neither
 * node nor loop expands, and loop's RPC does not validate cwd at all
 * (`session.create` happily accepts `/nope/does/not/exist`). An unchecked path
 * therefore becomes a project that looks real and works for nothing.
 *
 * `create` is the picker's "Create & Add", offered whenever the typed path has
 * nothing at it. Nothing here used to act on it, so that button could only ever
 * fail: the folder was never made, and the browse below then rejected the path
 * for not existing.
 */
async function resolveWorkspaceRoot(
  workspaceRoot: string,
  create: boolean,
  host: LoopHost,
): Promise<string> {
  const trimmed = workspaceRoot.trim();
  if (trimmed === "") throw new Error("A project needs a folder.");

  const filesystem = host.filesystem();
  // Over `loop serve` there is no filesystem to ask and loop cannot validate
  // a cwd, so the typed path is all there is.
  if (!filesystem) return trimmed;

  // The trailing separator is what makes browse list the folder ITSELF rather
  // than its parent, so parentPath comes back as the resolved folder.
  const withSeparator = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  const browsed = await filesystem.browse(withSeparator, undefined);
  if (browsed) return browsed.parentPath;

  if (!create) throw new Error(`${trimmed} is not a folder on this machine.`);
  if (!filesystem.createDirectory) {
    throw new Error(`${trimmed} does not exist, and this shell cannot create folders.`);
  }
  const created = await filesystem.createDirectory(trimmed);
  if (!created.ok) throw new Error(`Could not create ${trimmed}: ${created.failure}`);
  // Resolved by browsing rather than trusting what was typed, so the project
  // records the same real path an existing folder would have.
  const reBrowsed = await filesystem.browse(withSeparator, undefined);
  return reBrowsed?.parentPath ?? created.path;
}

export const dispatchCommand = Effect.fnUntraced(function* (
  command: ClientOrchestrationCommand,
  host: LoopHost = defaultLoopHost,
) {
  return yield* Effect.promise(() => run(command, host));
});

async function run(
  command: ClientOrchestrationCommand,
  host: LoopHost,
): Promise<{ sequence: number }> {
  switch (command.type) {
    case "project.create": {
      // Nothing is created in loop: it has no project record, and a folder
      // becomes a project by having a session in it. This settles WHICH folder
      // the id the palette just minted refers to, so the draft it opens next
      // lands in the right place, and holds the folder so the sidebar can show
      // it before the first turn makes it real.
      const folder = await resolveWorkspaceRoot(
        command.workspaceRoot,
        command.createWorkspaceRootIfMissing === true,
        host,
      );
      projectFolders.set(command.projectId, folder);
      rememberAddedProject(host.id, command.projectId, folder);
      return { sequence: 0 };
    }

    case "thread.create": {
      // The project id is the folder, so the workspace is already known.
      pending.set(command.threadId, {
        cwd: projectFolderFor(command.projectId),
        provider: fromInstanceId(command.modelSelection.instanceId),
        model: command.modelSelection.model,
      });
      return { sequence: 0 };
    }

    case "thread.turn.start": {
      const selection = command.modelSelection;
      // A draft's FIRST turn carries its own creation payload rather than
      // having been announced by an earlier `thread.create`. Measured the hard
      // way: without this the composer's first send reached loop with a
      // client-generated id, and loop rightly answered "Unknown sessionId".
      const bootstrap = command.bootstrap?.createThread;
      if (bootstrap && !bindings.has(command.threadId)) {
        pending.set(command.threadId, {
          cwd: projectFolderFor(bootstrap.projectId),
          provider: fromInstanceId(bootstrap.modelSelection.instanceId),
          model: bootstrap.modelSelection.model,
        });
      }
      const sessionId = await ensureSession(command.threadId, host);
      const send = () => sendTurn(sessionId, command.message, selection, host);
      try {
        await send();
      } catch (error) {
        // Typed while the agent was still working. Hold it and send it when
        // the running turn ends, rather than failing the command — which is
        // what put an error on the thread and made the user retype.
        if (!isTurnAlreadyRunning(error)) throw error;
        queueTurn({
          id: command.message.messageId,
          sessionId,
          threadId: command.threadId,
          text: command.message.text,
          attachmentCount: command.message.attachments?.length ?? 0,
          queuedAt: new Date().toISOString(),
          send,
          interrupt: async () => {
            await host.call("session.cancel", { sessionId });
          },
        });
      }
      return { sequence: 0 };
    }

    case "thread.turn.interrupt": {
      const sessionId = loopSessionIdFor(command.threadId);
      // Stop means stop. Anything still waiting behind this turn was queued
      // on the assumption it would finish; firing it the instant the user
      // cancelled would be the opposite of what the button says.
      discardQueuedTurns(sessionId);
      await host.call("session.cancel", { sessionId });
      return { sequence: 0 };
    }

    case "thread.archive":
    case "thread.unarchive": {
      // The gentler half of delete: nothing is removed, the conversation just
      // stops appearing in the sidebar. loop keeps it as a timestamp on the
      // session row, so unarchiving is the same call with `archived: false`.
      const sessionId = loopSessionIdFor(command.threadId);
      await host.call("session.archive", {
        sessionId,
        archived: command.type === "thread.archive",
      });
      // loop broadcasts nothing for this — it is a client asking, not the
      // agent acting — and the sidebar is rebuilt from `session.list`, which
      // now answers differently. Without the nudge the row you just archived
      // stays on screen until some unrelated turn happens to refresh it, and
      // archiving looks like it did nothing.
      notifyThreadChanged(sessionId);
      return { sequence: 0 };
    }

    case "thread.delete": {
      const sessionId = loopSessionIdFor(command.threadId);
      await host.call("session.delete", { sessionId });
      forgetThread(command.threadId);
      // Same reason as archive above: loop broadcasts nothing for a client's
      // own removal, and the sidebar is rebuilt from `session.list`. Without
      // the nudge the deleted row sits there until an unrelated turn happens
      // to refresh the shell, so deleting looks like it did nothing — the row
      // only goes away on the next relaunch.
      notifyThreadChanged(sessionId);
      return { sequence: 0 };
    }

    case "project.delete": {
      // loop has no project record to remove: a folder IS a project because
      // sessions have that cwd, so removing one means removing its sessions.
      // Anything the user added but never used is only remembered in-process,
      // and forgetting that is the whole removal.
      const folder = projectFolderFor(command.projectId);
      forgetAddedProject(host.id, command.projectId);
      // `archived: "all"` because the archive is part of the project too: the
      // default scope is the working set, so an archived conversation would
      // survive the folder it belongs to being removed and reappear the next
      // time the user opened the Archive panel.
      const listed = await host.call<unknown>("session.list", {
        cwd: folder,
        archived: "all",
      }).catch(() => []);
      // Guarded rather than trusted: a failed call is caught above, but a
      // reply that is not a list would throw here and leave the removal half
      // done with no error the user can act on.
      const rows = Array.isArray(listed) ? (listed as readonly { id: string; cwd: string }[]) : [];
      for (const row of rows) {
        if (row.cwd !== folder) continue;
        await host.call("session.delete", { sessionId: row.id }).catch(() => undefined);
      }
      // The project disappears when its last session does, so the shell has to
      // be rebuilt for the row to go — `forgetAddedProject` only notifies for
      // a folder no session ever claimed.
      notifyThreadChanged(folder);
      return { sequence: 0 };
    }

    case "thread.user-input.respond": {
      // loop's ask bridge is waiting on exactly this. Answers are positional
      // there and keyed by question id here, so they are ordered by that id
      // before being sent — the panel may hand them back in any order.
      const answers = (command as { answers?: Record<string, unknown> }).answers ?? {};
      const ordered = Object.entries(answers)
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([, value]) => ({
          answers: Array.isArray(value) ? value.map(String) : [String(value)],
        }));
      await host.call("session.answer", {
        askId: (command as { requestId: string }).requestId,
        answers: ordered,
      });
      clearLiveAsk(loopSessionIdFor(command.threadId));
      return { sequence: 0 };
    }

    case "thread.meta.update": {
      const title = command.title;
      if (typeof title === "string" && title.trim() !== "") {
        await host.call("session.rename", {
          sessionId: loopSessionIdFor(command.threadId),
          name: title,
        });
      }
      return { sequence: 0 };
    }

    // loop has no runtime or interaction modes (access is the bashApprove
    // setting, planning the plan agent), so there is nothing to change — but
    // refusing them wedged clients that set them before every send: the
    // phone's outbox retried the refused command forever and never reached
    // the turn. Accepted as no-ops.
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
      return { sequence: 0 };

    default:
      throw new UnsupportedCommandError(command.type);
  }
}
