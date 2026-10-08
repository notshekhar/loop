import type { ClientOrchestrationCommand } from "@loop/contracts";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { agentOptionOf, dispatchCommand, thinkingLevelOf } from "./dispatch.ts";
import { useQueuedTurnsStore } from "../../queuedTurnsStore.ts";
import {
  applyLoopEvent,
  notifyThreadChanged,
  onLiveTurnChange,
  readLiveTurn,
} from "./liveTurn.ts";

const globals = globalThis as { window?: Window & typeof globalThis };

interface Recorded {
  readonly method: string;
  readonly params: unknown;
}

/**
 * Runs commands against a stubbed bridge and reports what reached loop.
 *
 * `browse` answers the way the shell does: the resolved directory comes back
 * as `parentPath`, and an unreadable path comes back as null.
 */
async function dispatchWith(
  commands: readonly ClientOrchestrationCommand[],
  options: {
    browse?: (path: string) => { parentPath: string } | null;
    /** Omitted entirely to stand in for a shell that cannot make folders. */
    createDirectory?: (path: string) => { ok: true; path: string } | { ok: false; failure: string };
  } = {},
) {
  const calls: Recorded[] = [];
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: (method, params) => {
      calls.push({ method, params });
      return Promise.resolve(method === "session.create" ? { sessionId: "01LOOPSESSION" } : {});
    },
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
    fs: {
      list: () => Promise.reject(new Error("unused")),
      read: () => Promise.reject(new Error("unused")),
      // Not `?? default`: an override that answers null means "no such
      // folder", and `??` would quietly replace it with the default.
      browse: (partialPath: string) =>
        Promise.resolve(
          (options.browse
            ? options.browse(partialPath)
            : { parentPath: partialPath.replace(/\/$/, "") }) as never,
        ),
      ...(options.createDirectory
        ? {
            createDirectory: (path: string) => {
              calls.push({ method: "fs.createDirectory", params: { path } });
              return Promise.resolve(options.createDirectory!(path));
            },
          }
        : {}),
    },
  };
  try {
    for (const command of commands) await Effect.runPromise(dispatchCommand(command));
    return calls;
  } finally {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  }
}

const projectCreate = (
  projectId: string,
  workspaceRoot: string,
  createWorkspaceRootIfMissing = false,
) =>
  ({
    type: "project.create",
    commandId: `cmd-${projectId}`,
    projectId,
    title: "documents",
    workspaceRoot,
    createWorkspaceRootIfMissing,
    createdAt: "2026-08-06T00:00:00.000Z",
  }) as unknown as ClientOrchestrationCommand;

const threadCreate = (threadId: string, projectId: string) =>
  ({
    type: "thread.create",
    commandId: `cmd-${threadId}`,
    threadId,
    projectId,
    title: "New thread",
    modelSelection: { instanceId: "kimi", model: "kimi/k3" },
    runtimeMode: "full-access",
    interactionMode: "chat",
    branch: null,
    worktreePath: null,
    createdAt: "2026-08-06T00:00:00.000Z",
  }) as unknown as ClientOrchestrationCommand;

const turnStart = (
  threadId: string,
  modelSelection?: {
    instanceId: string;
    model: string;
    options?: { id: string; value: unknown }[];
  },
) =>
  ({
    type: "thread.turn.start",
    commandId: `cmd-turn-${threadId}`,
    threadId,
    message: { messageId: "m1", text: "hi" },
    ...(modelSelection === undefined ? {} : { modelSelection }),
  }) as unknown as ClientOrchestrationCommand;

// dispatch.ts keeps its id bindings in module state, deliberately — they
// outlive a draft. So every test needs its own ids or the previous test's
// session binding satisfies this one and no session.create is ever made.
let seed = 0;
const freshIds = () => {
  seed += 1;
  return { project: `01PROJECT${seed}`, thread: `01THREAD${seed}` };
};

// The queue is a module-global store, so a test that leaves something in it
// leaks into every test after it — which is how a later assertion about send
// ORDER picked up an earlier test's message.
beforeEach(() => {
  useQueuedTurnsStore.setState({ queue: [] });
});

describe("adding a project", () => {
  it("sends the turn to the folder the project was created with", async () => {
    // The palette mints a ULID for the project before anything knows where it
    // lives; without the binding that ULID would be sent to loop as a cwd.
    const id = freshIds();
    const calls = await dispatchWith([
      projectCreate(id.project, "/Users/someone/documents"),
      threadCreate(id.thread, id.project),
      turnStart(id.thread),
    ]);

    const created = calls.find((call) => call.method === "session.create");
    expect((created?.params as { cwd: string }).cwd).toBe("/Users/someone/documents");
  });

  it("resolves the typed path through the shell rather than trusting it", async () => {
    // "~" is a shell convention; the shell expands it and answers with the
    // real folder, which is what has to reach loop.
    const id = freshIds();
    const calls = await dispatchWith(
      [
        projectCreate(id.project, "~/documents"),
        threadCreate(id.thread, id.project),
        turnStart(id.thread),
      ],
      { browse: () => ({ parentPath: "/Users/someone/documents" }) },
    );

    const created = calls.find((call) => call.method === "session.create");
    expect((created?.params as { cwd: string }).cwd).toBe("/Users/someone/documents");
  });

  it("fails loudly on a folder that is not there", async () => {
    // loop's RPC accepts any cwd, so an unchecked path becomes a project that
    // looks real and works for nothing.
    const id = freshIds();
    await expect(
      dispatchWith([projectCreate(id.project, "/nope/does/not/exist")], {
        browse: () => null,
      }),
    ).rejects.toThrow(/not a folder/);
  });

  it("creates the folder when the picker offered Create & Add", async () => {
    // The button exists because the path has nothing at it, so the browse that
    // validates a folder cannot be what decides: without the mkdir this failed
    // as "not a folder on this machine" and the project was never added.
    const id = freshIds();
    let exists = false;
    const calls = await dispatchWith(
      [
        projectCreate(id.project, "~/code/brand-new", true),
        threadCreate(id.thread, id.project),
        turnStart(id.thread),
      ],
      {
        browse: () => (exists ? { parentPath: "/Users/someone/code/brand-new" } : null),
        createDirectory: (path) => {
          exists = true;
          return { ok: true, path };
        },
      },
    );

    expect(calls.find((call) => call.method === "fs.createDirectory")?.params).toEqual({
      path: "~/code/brand-new",
    });
    // The folder the shell resolved, not the "~" path that was typed.
    const created = calls.find((call) => call.method === "session.create");
    expect((created?.params as { cwd: string }).cwd).toBe("/Users/someone/code/brand-new");
  });

  it("does not create a folder the user did not ask to create", async () => {
    const id = freshIds();
    let attempted = false;
    await expect(
      dispatchWith([projectCreate(id.project, "/nope/does/not/exist")], {
        browse: () => null,
        createDirectory: (path) => {
          attempted = true;
          return { ok: true, path };
        },
      }),
    ).rejects.toThrow(/not a folder/);
    expect(attempted).toBe(false);
  });

  it("says why the folder could not be created", async () => {
    // The toast shows this sentence, so "permission denied" has to survive it.
    const id = freshIds();
    await expect(
      dispatchWith([projectCreate(id.project, "/etc/nope", true)], {
        browse: () => null,
        createDirectory: () => ({ ok: false, failure: "EACCES: permission denied" }),
      }),
    ).rejects.toThrow(/Could not create \/etc\/nope: EACCES/);
  });

  it("says so when the shell is too old to create folders", async () => {
    const id = freshIds();
    await expect(
      dispatchWith([projectCreate(id.project, "/w/new", true)], { browse: () => null }),
    ).rejects.toThrow(/cannot create folders/);
  });

  it("switches provider by sending the model id that carries it", async () => {
    // loop has no `provider` parameter on session.send: the model id IS the
    // provider (`xai/composer-2.5`), and runTurn resolves it from there. So a
    // provider switch is only a switch if the FULL slug reaches loop — sending
    // a bare model name would silently keep the session's original provider.
    const id = freshIds();
    const calls = await dispatchWith([
      threadCreate(id.thread, "/Users/someone/project"),
      turnStart(id.thread, { instanceId: "kimi", model: "kimi/k3" }),
    ]);
    const send = calls.find((call) => call.method === "session.send");
    expect((send?.params as { model?: string }).model).toBe("kimi/k3");

    const switched = freshIds();
    const after = await dispatchWith([
      threadCreate(switched.thread, "/Users/someone/project"),
      turnStart(switched.thread, { instanceId: "xai", model: "xai/composer-2.5" }),
    ]);
    expect(
      (after.find((call) => call.method === "session.send")?.params as { model?: string }).model,
    ).toBe("xai/composer-2.5");
  });

  it("sends the composer's effort as loop's thinking level", async () => {
    // `/thinking` in the terminal. loop's session.send takes it per turn, and
    // the app never sent it — the effort control did nothing.
    const id = freshIds();
    const calls = await dispatchWith([
      threadCreate(id.thread, "/Users/someone/project"),
      turnStart(id.thread, {
        instanceId: "kimi",
        model: "kimi/k3",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ]);
    expect((calls.find((c) => c.method === "session.send")?.params as { thinking?: string }).thinking).toBe(
      "high",
    );
  });

  it("leaves a project id that is already a folder alone", async () => {
    const id = freshIds();
    const calls = await dispatchWith([
      threadCreate(id.thread, "/Users/someone/project"),
      turnStart(id.thread),
    ]);

    const created = calls.find((call) => call.method === "session.create");
    expect((created?.params as { cwd: string }).cwd).toBe("/Users/someone/project");
  });
});

// loop has no runtime or interaction modes. Refusing the commands that set
// them wedged the phone's outbox: it sets both before every send, retried the
// refusal forever, and the message never left the queue.
describe("modes loop does not have", () => {
  it("accepts runtime- and interaction-mode changes, then sends the turn", async () => {
    const id = freshIds();
    const calls = await dispatchWith([
      threadCreate(id.thread, "/Users/someone/project"),
      {
        type: "thread.runtime-mode.set",
        commandId: "cmd-runtime",
        threadId: id.thread,
        runtimeMode: "full-access",
        createdAt: "2026-10-08T00:00:00.000Z",
      } as unknown as ClientOrchestrationCommand,
      {
        type: "thread.interaction-mode.set",
        commandId: "cmd-interaction",
        threadId: id.thread,
        interactionMode: "default",
        createdAt: "2026-10-08T00:00:00.000Z",
      } as unknown as ClientOrchestrationCommand,
      turnStart(id.thread),
    ]);
    expect(calls.some((call) => call.method === "session.send")).toBe(true);
  });
});

describe("the composer's effort as loop's thinking level", () => {
  it("passes through the levels both vocabularies share", () => {
    for (const level of ["minimal", "low", "medium", "high"]) {
      expect(thinkingLevelOf([{ id: "reasoningEffort", value: level }])).toBe(level);
    }
  });

  it("accepts loop's own extremes", () => {
    expect(thinkingLevelOf([{ id: "reasoningEffort", value: "off" }])).toBe("off");
    expect(thinkingLevelOf([{ id: "reasoningEffort", value: "xhigh" }])).toBe("xhigh");
  });

  it("is case-insensitive", () => {
    expect(thinkingLevelOf([{ id: "reasoningEffort", value: "High" }])).toBe("high");
  });

  it("says nothing rather than guessing, so loop falls back to its setting", () => {
    expect(thinkingLevelOf(undefined)).toBeUndefined();
    expect(thinkingLevelOf([])).toBeUndefined();
    expect(thinkingLevelOf([{ id: "verbosity", value: "high" }])).toBeUndefined();
    expect(thinkingLevelOf([{ id: "reasoningEffort", value: "turbo" }])).toBeUndefined();
    expect(thinkingLevelOf([{ id: "reasoningEffort", value: 3 }])).toBeUndefined();
  });
});

describe("removing things", () => {
  it("deletes a thread's loop session", async () => {
    const id = freshIds();
    const calls = await dispatchWith([
      {
        type: "thread.delete",
        commandId: "cmd-del",
        threadId: id.thread,
      } as unknown as ClientOrchestrationCommand,
    ]);
    expect(calls.find((call) => call.method === "session.delete")?.params).toMatchObject({
      sessionId: id.thread,
    });
  });

  it("removes a project by deleting the sessions that make it one", async () => {
    // loop has no project record: a folder IS a project because sessions have
    // that cwd, so removal means removing them.
    const id = freshIds();
    const calls = await dispatchWith([
      projectCreate(id.project, "/w/doomed"),
      {
        type: "project.delete",
        commandId: "cmd-rm",
        projectId: id.project,
      } as unknown as ClientOrchestrationCommand,
    ]);
    const listed = calls.find((call) => call.method === "session.list");
    // `archived: "all"` or an archived conversation outlives the folder it
    // belongs to and comes back in the Archive panel.
    expect(listed?.params).toMatchObject({ cwd: "/w/doomed", archived: "all" });
  });

  it("rebuilds the shell after a delete, or the row it deleted stays on screen", async () => {
    // Nothing else refreshes the sidebar: loop broadcasts nothing for a
    // client's own removal, so without this nudge the deleted conversation is
    // gone from the database and still visible until the next relaunch.
    const seen: string[] = [];
    const unsubscribe = onLiveTurnChange((sessionId) => seen.push(sessionId));
    try {
      await dispatchWith([
        { type: "thread.delete", commandId: "cmd-del", threadId: "01SESSION" } as never,
      ]);
    } finally {
      unsubscribe();
    }
    expect(seen).toContain("01SESSION");
  });

  it("rebuilds the shell after a project is removed", async () => {
    // `forgetAddedProject` only notifies for a folder no session ever claimed,
    // and a real project is exactly the other case.
    const id = freshIds();
    const seen: string[] = [];
    const unsubscribe = onLiveTurnChange((sessionId) => seen.push(sessionId));
    try {
      await dispatchWith([
        projectCreate(id.project, "/w/doomed"),
        {
          type: "project.delete",
          commandId: "cmd-rm",
          projectId: id.project,
        } as unknown as ClientOrchestrationCommand,
      ]);
    } finally {
      unsubscribe();
    }
    expect(seen).toContain("/w/doomed");
  });
});

describe("running a turn under an agent", () => {
  it("sends the agent loop's one-shot form expects", async () => {
    const id = freshIds();
    const calls = await dispatchWith([
      threadCreate(id.thread, "/Users/someone/project"),
      turnStart(id.thread, {
        instanceId: "kimi",
        model: "kimi/k3",
        options: [{ id: "agent", value: "explore" }],
      }),
    ]);
    expect((calls.find((c) => c.method === "session.send")?.params as { agent?: string }).agent).toBe(
      "explore",
    );
  });

  it("says nothing for the built-in persona", () => {
    // Sending nothing already means the default, so naming it is noise.
    expect(agentOptionOf([{ id: "agent", value: "default" }])).toBeUndefined();
    expect(agentOptionOf([{ id: "agent", value: "  " }])).toBeUndefined();
    expect(agentOptionOf(undefined)).toBeUndefined();
    expect(agentOptionOf([{ id: "reasoningEffort", value: "high" }])).toBeUndefined();
  });

  it("keeps agent and effort independent", () => {
    const options = [
      { id: "agent", value: "explore" },
      { id: "reasoningEffort", value: "high" },
    ];
    expect(agentOptionOf(options)).toBe("explore");
    expect(thinkingLevelOf(options)).toBe("high");
  });
});

describe("archiving a thread", () => {
  it("archives and unarchives through loop's own session.archive", async () => {
    const archived = await dispatchWith([
      { type: "thread.archive", commandId: "c1", threadId: "01SESSION" } as never,
    ]);
    expect(archived).toEqual([
      { method: "session.archive", params: { sessionId: "01SESSION", archived: true } },
    ]);

    const restored = await dispatchWith([
      { type: "thread.unarchive", commandId: "c2", threadId: "01SESSION" } as never,
    ]);
    expect(restored).toEqual([
      { method: "session.archive", params: { sessionId: "01SESSION", archived: false } },
    ]);
  });

  it("tells the shell to rebuild, or the row stays on screen", async () => {
    // loop broadcasts nothing for an archive — it is a client asking, not the
    // agent acting — and the sidebar is built from `session.list`, which now
    // answers differently. Without this nudge the row you just archived sits
    // there until some unrelated turn happens to refresh it.
    const seen: string[] = [];
    const unsubscribe = onLiveTurnChange((sessionId) => seen.push(sessionId));
    try {
      await dispatchWith([
        { type: "thread.archive", commandId: "c1", threadId: "01SESSION" } as never,
      ]);
    } finally {
      unsubscribe();
    }
    expect(seen).toContain("01SESSION");
  });
});

describe("sending while a turn is running", () => {
  /**
   * A bridge that stays installed, because the interesting part happens after
   * the command returns: the queued message is sent from a live-turn listener,
   * long after `dispatchWith` would have put the previous bridge back.
   */
  function installBridge(sessionId: string) {
    const calls: Recorded[] = [];
    let busy = true;
    const hadWindow = globals.window !== undefined;
    globals.window ??= globals as unknown as Window & typeof globalThis;
    const previous = window.loop;
    window.loop = {
      call: (method, params) => {
        calls.push({ method, params });
        if (method === "session.create") return Promise.resolve({ sessionId } as never);
        if (method === "session.send" && busy) {
          return Promise.reject(
            new Error(`session ${sessionId} already has a turn running (cancel it first)`),
          );
        }
        return Promise.resolve({} as never);
      },
      onEvent: () => () => {},
      anchorCwd: () => Promise.resolve(undefined),
      fs: {
        list: () => Promise.reject(new Error("unused")),
        read: () => Promise.reject(new Error("unused")),
        browse: (partialPath: string) =>
          Promise.resolve({ parentPath: partialPath.replace(/\/$/, ""), entries: [] } as never),
      },
    };
    return {
      calls,
      sends: () => calls.filter((call) => call.method === "session.send"),
      finish: () => {
        busy = false;
      },
      dispatch: (command: ClientOrchestrationCommand) =>
        Effect.runPromise(dispatchCommand(command)),
      restore: () => {
        if (previous === undefined) delete window.loop;
        else window.loop = previous;
        if (!hadWindow) delete globals.window;
      },
    };
  }

  it("queues the message instead of failing the send", async () => {
    // loop takes one turn at a time and refuses a second outright. Before the
    // queue that refusal surfaced as a thread error and the composer handed
    // the text back, so hitting Enter mid-stream simply lost the message.
    const id = freshIds();
    const bridge = installBridge(`01QUEUED${id.thread}`);
    try {
      await bridge.dispatch(threadCreate(id.thread, "/Users/someone/project"));
      await bridge.dispatch(turnStart(id.thread));
      expect(bridge.sends()).toHaveLength(1);

      bridge.finish();
      notifyThreadChanged(`01QUEUED${id.thread}`);
      await Promise.resolve();
      await Promise.resolve();
      expect(bridge.sends()).toHaveLength(2);
    } finally {
      bridge.restore();
    }
  });

  it("leaves the running turn's live buffer alone when the send is refused", async () => {
    // The send opens its live turn before calling, or a delta that beats the
    // response is lost. On a refusal that buffer belongs to the turn still
    // streaming, so putting it back is what stops the reply on screen from
    // blanking every time someone queues a message.
    const id = freshIds();
    const bridge = installBridge(`01LIVE${id.thread}`);
    try {
      await bridge.dispatch(threadCreate(id.thread, "/Users/someone/project"));
      await bridge.dispatch(turnStart(id.thread));
      expect(readLiveTurn(`01LIVE${id.thread}`)).toBeUndefined();
    } finally {
      bridge.restore();
    }
  });

  it("drops the queue when the user interrupts", async () => {
    // Stop means stop: a message queued behind a turn was queued expecting it
    // to finish, and firing it the moment the user cancelled is the opposite
    // of what the button says.
    const id = freshIds();
    const sessionId = `01CANCEL${id.thread}`;
    const bridge = installBridge(sessionId);
    try {
      await bridge.dispatch(threadCreate(id.thread, "/Users/someone/project"));
      await bridge.dispatch(turnStart(id.thread));
      await bridge.dispatch({
        type: "thread.turn.interrupt",
        commandId: "c-interrupt",
        threadId: id.thread,
      } as unknown as ClientOrchestrationCommand);

      bridge.finish();
      notifyThreadChanged(sessionId);
      await Promise.resolve();
      await Promise.resolve();
      expect(bridge.sends()).toHaveLength(1);
    } finally {
      bridge.restore();
    }
  });
});

describe("attachments", () => {
  const turnStartWithAttachments = (
    threadId: string,
    attachments: ReadonlyArray<{
      type: "image" | "file";
      name: string;
      mimeType: string;
      sizeBytes: number;
      dataUrl: string;
    }>,
  ) =>
    ({
      type: "thread.turn.start",
      commandId: `cmd-turn-${threadId}`,
      threadId,
      message: { messageId: "m1", text: "look at this", attachments },
    }) as unknown as ClientOrchestrationCommand;

  it("forwards staged attachments to loop instead of dropping them", async () => {
    // The whole attachment feature was dead at this seam: the composer staged
    // images, drew their thumbnails and put them on the command, and the turn
    // went out with `input` alone — so the model answered about a picture it
    // was never shown.
    const id = freshIds();
    const calls = await dispatchWith([
      threadCreate(id.thread, "/Users/someone/project"),
      turnStartWithAttachments(id.thread, [
        {
          type: "image",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,AAAA",
        },
        {
          type: "file",
          name: "spec.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
          dataUrl: "data:application/pdf;base64,BBBB",
        },
      ]),
    ]);

    const send = calls.find((call) => call.method === "session.send");
    expect((send?.params as { images?: unknown }).images).toEqual([
      { data: "AAAA", mediaType: "image/png" },
      { data: "BBBB", mediaType: "application/pdf" },
    ]);
  });

  it("omits the field entirely when nothing is attached", async () => {
    const id = freshIds();
    const calls = await dispatchWith([
      threadCreate(id.thread, "/Users/someone/project"),
      turnStart(id.thread),
    ]);
    const send = calls.find((call) => call.method === "session.send");
    expect((send?.params as { images?: unknown }).images).toBeUndefined();
  });

  it("drops a payload that is not a data URL rather than sending junk bytes", async () => {
    const id = freshIds();
    const calls = await dispatchWith([
      threadCreate(id.thread, "/Users/someone/project"),
      turnStartWithAttachments(id.thread, [
        { type: "image", name: "x.png", mimeType: "image/png", sizeBytes: 1, dataUrl: "AAAA" },
      ]),
    ]);
    const send = calls.find((call) => call.method === "session.send");
    expect((send?.params as { images?: unknown }).images).toBeUndefined();
  });
});

describe("queueing more than one message", () => {
  /**
   * The CLI's queue is unbounded and the desktop app's has to be too. What
   * limited it was never the queue: `beginLocalDispatch` left the composer in
   * its local "sending" state until the server acknowledged the send, a queued
   * message produces no server-side change at all, and `onSend` early-returns
   * while the composer is busy — so the second message never arrived. This
   * covers the half that lives here: any number in, in order out, one per turn.
   */
  function installBridge(sessionId: string) {
    const calls: Recorded[] = [];
    let busy = true;
    const hadWindow = globals.window !== undefined;
    globals.window ??= globals as unknown as Window & typeof globalThis;
    const previous = window.loop;
    window.loop = {
      call: (method, params) => {
        calls.push({ method, params });
        if (method === "session.create") return Promise.resolve({ sessionId } as never);
        if (method === "session.send" && busy) {
          return Promise.reject(
            new Error(`session ${sessionId} already has a turn running (cancel it first)`),
          );
        }
        return Promise.resolve({} as never);
      },
      onEvent: () => () => {},
      anchorCwd: () => Promise.resolve(undefined),
      fs: {
        list: () => Promise.reject(new Error("unused")),
        read: () => Promise.reject(new Error("unused")),
        browse: (partialPath: string) =>
          Promise.resolve({ parentPath: partialPath.replace(/\/$/, ""), entries: [] } as never),
      },
    };
    return {
      sentTexts: () =>
        calls
          .filter((call) => call.method === "session.send")
          .map((call) => (call.params as { input: string }).input),
      finish: () => {
        busy = false;
      },
      dispatch: (command: ClientOrchestrationCommand) =>
        Effect.runPromise(dispatchCommand(command)),
      restore: () => {
        if (previous === undefined) delete window.loop;
        else window.loop = previous;
        if (!hadWindow) delete globals.window;
      },
    };
  }

  const turnStartSaying = (threadId: string, text: string) =>
    ({
      type: "thread.turn.start",
      commandId: `cmd-turn-${text}`,
      threadId,
      message: { messageId: `m-${text}`, role: "user", text, attachments: [] },
    }) as unknown as ClientOrchestrationCommand;

  it("holds every message and sends them in the order they were typed", async () => {
    const id = freshIds();
    const sessionId = `01MANY${id.thread}`;
    const bridge = installBridge(sessionId);
    try {
      await bridge.dispatch(threadCreate(id.thread, "/Users/someone/project"));
      await bridge.dispatch(turnStartSaying(id.thread, "one"));
      await bridge.dispatch(turnStartSaying(id.thread, "two"));
      await bridge.dispatch(turnStartSaying(id.thread, "three"));

      // Each refusal is one attempted send; nothing has actually gone through.
      expect(useQueuedTurnsStore.getState().queue.map((turn) => turn.text)).toEqual([
        "one",
        "two",
        "three",
      ]);

      bridge.finish();
      // One per turn end, not the whole queue at once — the send that succeeds
      // starts a turn the rest have to wait behind.
      for (const _ of [0, 1, 2]) {
        applyLoopEvent(sessionId, { type: "finish", data: {} });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(bridge.sentTexts().slice(-3)).toEqual(["one", "two", "three"]);
      expect(useQueuedTurnsStore.getState().queue).toHaveLength(0);
    } finally {
      useQueuedTurnsStore.setState({ queue: [] });
      bridge.restore();
    }
  });
});
