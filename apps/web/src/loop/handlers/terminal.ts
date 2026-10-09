/**
 * Terminals, backed by real PTYs in the desktop shell.
 *
 * Same shape as the file handlers and for the same reason: loop's RPC has no
 * terminal and a browser cannot fork a shell, so this works in the desktop app
 * and fails with a reason elsewhere.
 *
 * Terminal ids are chosen by the renderer — the contract is explicit that there
 * is no server-side allocation — so every call here already knows which
 * terminal it means, and `open` on a live id reattaches rather than spawning a
 * second shell.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  TerminalSessionSnapshot as TerminalSessionSnapshotSchema,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  defaultLoopHost,
  type LoopHost,
  type TerminalOutput,
  type TerminalSnapshot,
} from "../transport.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(TerminalSessionSnapshotSchema);

const unavailable = () =>
  new EnvironmentAuthorizationError({
    message: "Terminals need loop's desktop app; the browser build cannot open a shell",
    requiredScope: AuthOrchestrationReadScope,
  });

const malformed = () =>
  new EnvironmentAuthorizationError({
    message: "The terminal returned an unexpected snapshot",
    requiredScope: AuthOrchestrationReadScope,
  });

/**
 * A pty call whose refusal reaches the screen as a message.
 *
 * `Effect.promise` turns a rejection into a defect, so a host refusing the
 * terminal ("off for other devices") killed the stream with nothing to show —
 * the phone's terminal just never came up. The host's own sentence says why
 * and how to turn it on; this carries it through.
 */
const ptyCall = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new EnvironmentAuthorizationError({
        message: error instanceof Error ? error.message : String(error),
        requiredScope: AuthOrchestrationReadScope,
      }),
  });

const toContract = (snapshot: TerminalSnapshot) =>
  decodeSnapshot(snapshot).pipe(Effect.mapError(malformed));

export const openTerminal = Effect.fnUntraced(function* (
  input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly cwd: string;
    readonly worktreePath?: string | null | undefined;
    readonly cols?: number | undefined;
    readonly rows?: number | undefined;
  },
  host: LoopHost = defaultLoopHost,
) {
  const pty = host.pty();
  if (!pty) return yield* Effect.fail(unavailable());
  const snapshot = yield* ptyCall(() =>
    pty.open({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows }),
    }),
  );
  return yield* toContract(snapshot);
});

export const writeTerminal = Effect.fnUntraced(function* (
  input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly data: string;
  },
  host: LoopHost = defaultLoopHost,
) {
  const pty = host.pty();
  if (!pty) return yield* Effect.fail(unavailable());
  yield* Effect.promise(() => pty.write(input.threadId, input.terminalId, input.data));
});

export const resizeTerminal = Effect.fnUntraced(function* (
  input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
  },
  host: LoopHost = defaultLoopHost,
) {
  const pty = host.pty();
  if (!pty) return yield* Effect.fail(unavailable());
  yield* Effect.promise(() =>
    pty.resize(input.threadId, input.terminalId, input.cols, input.rows),
  );
});

export const clearTerminal = Effect.fnUntraced(function* (
  input: {
    readonly threadId: string;
    readonly terminalId: string;
  },
  host: LoopHost = defaultLoopHost,
) {
  const pty = host.pty();
  if (!pty) return yield* Effect.fail(unavailable());
  yield* Effect.promise(() => pty.clear(input.threadId, input.terminalId));
});

/** An absent terminalId means every terminal of the thread; see the contract. */
export const closeTerminal = Effect.fnUntraced(function* (
  input: {
    readonly threadId: string;
    readonly terminalId?: string | undefined;
  },
  host: LoopHost = defaultLoopHost,
) {
  const pty = host.pty();
  if (!pty) return yield* Effect.fail(unavailable());
  yield* Effect.promise(() => pty.close(input.threadId, input.terminalId));
});

/** Output from every terminal, for the panel's global subscription. */
export function terminalEventStream(
  host: LoopHost = defaultLoopHost,
): Stream.Stream<TerminalEvent, EnvironmentAuthorizationError> {
  const pty = host.pty();
  // Idle rather than fail: this is opened when the panel mounts, not by an
  // action, and failing a connect-time subscription is how you lose a render.
  if (!pty) return Stream.never;
  return Stream.callback<TerminalEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        pty.onOutput((event) => {
          const mapped = toEvent(event);
          if (mapped) Queue.offerUnsafe(queue, mapped);
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid),
  );
}

/**
 * The attach stream: the scrollback first, then live output.
 *
 * Ordering is the whole contract here — a client that received output before
 * the snapshot would paint the new bytes and then wipe them with the history.
 */
export function attachTerminal(
  input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly cwd?: string | undefined;
    readonly cols?: number | undefined;
    readonly rows?: number | undefined;
  },
  host: LoopHost = defaultLoopHost,
): Stream.Stream<TerminalAttachStreamEvent, EnvironmentAuthorizationError> {
  const pty = host.pty();
  if (!pty) return Stream.fail(unavailable());

  return Stream.callback<TerminalAttachStreamEvent, EnvironmentAuthorizationError>((queue) =>
    Effect.gen(function* () {
      /**
       * Chunks that arrived before the snapshot did.
       *
       * The subscription is taken FIRST and the snapshot asked for second,
       * which is the whole fix: reading the snapshot and only then subscribing
       * left a window the width of an IPC round trip, and what a freshly
       * spawned shell writes in exactly that window is its first prompt. It
       * was dropped on the floor, so the pane came up blank — but only when
       * the shell beat the round trip, which is why it worked some of the time
       * and not others.
       *
       * Subscribing first means these chunks straddle the snapshot instead:
       * the ones taken before its `history` was captured are already inside
       * it. `sequence` says which, so they are dropped rather than painted
       * twice. See TerminalSnapshot in the desktop shell.
       */
      const buffered: TerminalOutput[] = [];
      let live = false;

      const deliver = (event: TerminalOutput) => {
        if (event.type === "started") {
          // A shell starting under an id this stream is already attached to
          // means the previous session is gone. Re-emitting a snapshot makes
          // the client REPLACE its buffer; without it the reopened pane painted
          // the dead session's scrollback and then appended the new prompt
          // below it — two prompts, and a stray `%` where zsh's partial-line
          // marker was written mid-line and so could not erase itself.
          if (event.snapshot) {
            Queue.offerUnsafe(queue, {
              type: "snapshot",
              snapshot: event.snapshot,
            } as TerminalAttachStreamEvent);
          }
          return;
        }
        const mapped = toEvent(event);
        if (mapped) Queue.offerUnsafe(queue, mapped);
      };

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          pty.onOutput((event) => {
            if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) return;
            if (live) deliver(event);
            else buffered.push(event);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );

      const existing = yield* ptyCall(() => pty.snapshot(input.threadId, input.terminalId));
      const snapshot =
        existing ??
        (yield* ptyCall(() =>
          pty.open({
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd: input.cwd ?? "",
            ...(input.cols === undefined ? {} : { cols: input.cols }),
            ...(input.rows === undefined ? {} : { rows: input.rows }),
          }),
        ));
      const decoded = yield* toContract(snapshot);
      Queue.offerUnsafe(queue, { type: "snapshot", snapshot: decoded });

      /**
       * How much of the buffer the snapshot already accounts for.
       *
       * A shell that restarted mid-gap resets its own count, so a buffered
       * `started` moves the boundary with it — otherwise the new shell's
       * chunks would be measured against the dead one's total and discarded,
       * which is the blank pane again by a longer route.
       */
      let covered = snapshot.sequence;
      for (const event of buffered) {
        if (event.type === "started") {
          covered = event.snapshot?.sequence;
          deliver(event);
          continue;
        }
        if (event.type === "output" && !isAfter(event.sequence, covered)) continue;
        deliver(event);
      }
      buffered.length = 0;
      live = true;
    }),
  );
}

/**
 * Whether a buffered chunk falls after the snapshot's boundary.
 *
 * Unknown counts as "not after", so a shell that reports no `sequence` keeps
 * the pre-fix behaviour: the straddling chunks are dropped and `history` is
 * trusted alone. The alternative — keeping them — would paint the part already
 * inside `history` a second time, and a doubled prompt is a visible corruption
 * where the old behaviour was merely a blank line. Unreachable in a shipped
 * build, where the shell and this renderer are packaged together.
 */
function isAfter(sequence: number | undefined, covered: number | undefined): boolean {
  if (sequence === undefined || covered === undefined) return false;
  return sequence > covered;
}

function toEvent(event: TerminalOutput): (TerminalEvent & TerminalAttachStreamEvent) | null {
  const base = { threadId: event.threadId, terminalId: event.terminalId };
  switch (event.type) {
    case "output":
      return { ...base, type: "output", data: event.data ?? "" } as TerminalEvent & TerminalAttachStreamEvent;
    case "exited":
      return {
        ...base,
        type: "exited",
        exitCode: event.exitCode ?? null,
        exitSignal: event.exitSignal ?? null,
      } as TerminalEvent & TerminalAttachStreamEvent;
    case "closed":
      return { ...base, type: "closed" } as TerminalEvent & TerminalAttachStreamEvent;
    default:
      return null;
  }
}
