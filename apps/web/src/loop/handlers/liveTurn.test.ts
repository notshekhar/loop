/**
 * The live turn: loop's event stream folded into the state a row is drawn
 * from. These feed `applyLoopEvent` the exact wire shape the RPC server
 * broadcasts (`{type, data}` per TURN_EVENT_NAMES), so they exercise the real
 * path rather than a paraphrase of it.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  abandonLiveTurn,
  adoptRunningTurn,
  applyLoopEvent,
  beginLiveTurn,
  clearLiveTurn,
  forgetEventSeq,
  lastEventSeq,
  liveTurnText,
  readLiveTurn,
} from "./liveTurn.ts";

// Subscribing to the event stream is the first thing beginLiveTurn does, and
// with no shell present the transport reaches for a WebSocket against a
// `location` this environment has not got. A desktop bridge is the cheaper of
// the two paths to stand up.
const globals = globalThis as { window?: Window & typeof globalThis };
globals.window ??= globals as unknown as Window & typeof globalThis;
window.loop ??= {
  call: () => Promise.resolve({}),
  onEvent: () => () => {},
  anchorCwd: () => Promise.resolve(undefined),
};

let seed = 0;
function session(): string {
  seed += 1;
  return `01SESSION${seed}`;
}

describe("thinking", () => {
  it("opens a block on the first delta even without a start event", () => {
    // Not every provider emits reasoning-start; a block that only opens on it
    // silently drops the model's thinking.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "reasoning-delta", data: "weighing it up" });
    expect(readLiveTurn(id)?.thinking.map((block) => block.text)).toEqual(["weighing it up"]);
    clearLiveTurn(id);
  });

  it("times a block from start to end", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "reasoning-start", data: undefined });
    applyLoopEvent(id, { type: "reasoning-delta", data: "hmm" });
    applyLoopEvent(id, { type: "reasoning-end", data: undefined });
    const block = readLiveTurn(id)?.thinking[0];
    expect(block?.text).toBe("hmm");
    expect(block?.endedAt).toBeDefined();
    expect(block!.endedAt! - block!.startedAt).toBeGreaterThanOrEqual(0);
    clearLiveTurn(id);
  });

  it("closes the open block when a tool starts", () => {
    // The terminal shows "Thought for 1.2s" the moment the model acts on it,
    // not when the whole turn finishes.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "reasoning-delta", data: "first" });
    applyLoopEvent(id, {
      type: "tool-input-start",
      data: { toolCallId: "call-1", toolName: "read" },
    });
    expect(readLiveTurn(id)?.thinking[0]?.endedAt).toBeDefined();
    clearLiveTurn(id);
  });

  it("keeps a second round of thinking as its own block", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "reasoning-delta", data: "first" });
    applyLoopEvent(id, { type: "reasoning-end", data: undefined });
    applyLoopEvent(id, { type: "reasoning-delta", data: "second" });
    expect(readLiveTurn(id)?.thinking.map((block) => block.text)).toEqual(["first", "second"]);
    clearLiveTurn(id);
  });

  it("closes an open block when the turn finishes", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "reasoning-delta", data: "unfinished" });
    applyLoopEvent(id, { type: "finish", data: {} });
    expect(readLiveTurn(id)?.thinking[0]?.endedAt).toBeDefined();
    clearLiveTurn(id);
  });
});

describe("assistant text", () => {
  it("is one run until a tool interrupts it", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "text-delta", data: "STAR" });
    applyLoopEvent(id, { type: "text-delta", data: "TING" });
    expect(readLiveTurn(id)?.texts.map((run) => run.text)).toEqual(["STARTING"]);
    clearLiveTurn(id);
  });

  it("starts a new run after a tool, so later text renders below it", () => {
    // Concatenating into one block forces the whole reply above or below every
    // call the turn made — the ordering bug this exists to prevent.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "text-delta", data: "STARTING" });
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "c1", toolName: "bash" } });
    applyLoopEvent(id, { type: "text-delta", data: "FINISHED" });
    expect(readLiveTurn(id)?.texts.map((run) => run.text)).toEqual(["STARTING", "FINISHED"]);
    expect(liveTurnText(readLiveTurn(id)!)).toBe("STARTINGFINISHED");
    clearLiveTurn(id);
  });
});

describe("tool calls", () => {
  it("buffers streaming input only for the tools the terminal buffers", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "w", toolName: "write" } });
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "r", toolName: "read" } });
    applyLoopEvent(id, { type: "tool-input-delta", data: { toolCallId: "w", delta: '{"path":"a' } });
    applyLoopEvent(id, { type: "tool-input-delta", data: { toolCallId: "r", delta: "ignored" } });
    const tools = readLiveTurn(id)!.tools;
    expect(tools.find((tool) => tool.id === "w")?.inputBuffer).toBe('{"path":"a');
    expect(tools.find((tool) => tool.id === "r")?.inputBuffer).toBeUndefined();
    clearLiveTurn(id);
  });

  it("records a subagent's live tool as the task row's status", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "t1", toolName: "task" } });
    applyLoopEvent(id, {
      type: "subagent-tool",
      data: { toolCallId: "t1", agent: "explore", toolName: "grep" },
    });
    applyLoopEvent(id, {
      type: "subagent-step-usage",
      data: { toolCallId: "t1", agent: "explore", steps: 3, usd: 0.012 },
    });
    const tool = readLiveTurn(id)!.tools[0];
    expect(tool).toMatchObject({ agent: "explore", statusText: "grep", steps: 3, usd: 0.012 });
    clearLiveTurn(id);
  });

  it("marks a call finished and times it", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "c1", toolName: "bash" } });
    applyLoopEvent(id, { type: "tool-result", data: { toolCallId: "c1", output: "hi" } });
    const tool = readLiveTurn(id)!.tools[0];
    expect(tool?.done).toBe(true);
    expect(tool?.endedAt).toBeDefined();
    clearLiveTurn(id);
  });
});

describe("the post-turn recap", () => {
  it("is captured from the data-recap event", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "data-recap", data: { text: "Renamed the flag." } });
    expect(readLiveTurn(id)?.recap).toBe("Renamed the flag.");
    clearLiveTurn(id);
  });

  it("ignores an empty one", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "data-recap", data: { text: "   " } });
    expect(readLiveTurn(id)?.recap).toBeUndefined();
    clearLiveTurn(id);
  });
});

describe("a hook rewriting a tool call", () => {
  it("keeps the rewritten command, not the one the model wrote", () => {
    // MEASURED on a real turn: a hook turned `cat poem.txt` into
    // `rtk read poem.txt`, and `tool-call` — carrying the model's ORIGINAL
    // input — lands AFTER the rewrite. Letting it win showed a command that
    // never ran.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "c1", toolName: "bash" } });
    applyLoopEvent(id, {
      type: "tool-input-updated",
      data: { toolCallId: "c1", toolName: "bash", input: { command: "rtk read poem.txt" } },
    });
    applyLoopEvent(id, {
      type: "tool-call",
      data: { toolCallId: "c1", toolName: "bash", input: { command: "cat poem.txt" } },
    });
    expect(readLiveTurn(id)?.tools[0]?.input).toEqual({ command: "rtk read poem.txt" });
    clearLiveTurn(id);
  });

  it("still takes the model's input when no hook rewrote it", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "tool-input-start", data: { toolCallId: "c1", toolName: "bash" } });
    applyLoopEvent(id, {
      type: "tool-call",
      data: { toolCallId: "c1", toolName: "bash", input: { command: "cat poem.txt" } },
    });
    expect(readLiveTurn(id)?.tools[0]?.input).toEqual({ command: "cat poem.txt" });
    clearLiveTurn(id);
  });
});

describe("hook output", () => {
  it("is kept in order so the transcript can show it", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "hook-message", data: "prettier rewrote 3 files" });
    expect(readLiveTurn(id)?.hooks.map((hook) => hook.text)).toEqual(["prettier rewrote 3 files"]);
    clearLiveTurn(id);
  });

  it("ignores a blank line", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "hook-message", data: "  " });
    expect(readLiveTurn(id)?.hooks).toHaveLength(0);
    clearLiveTurn(id);
  });
});

describe("step usage", () => {
  it("carries the running session spend and a live context estimate", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, {
      type: "step-usage",
      data: {
        usage: { inputTokens: 12_000, outputTokens: 800 },
        breakdown: { usd: 0.0431, inputTokens: 12_000, outputTokens: 800, cachedInputTokens: 4_000 },
      },
    });
    const usage = readLiveTurn(id)?.usage;
    expect(usage?.usd).toBe(0.0431);
    expect(usage?.contextTokens).toBe(12_800);
    clearLiveTurn(id);
  });

  it("does not force a transcript re-read", () => {
    // A delta-shaped event: it adds nothing to loop's persisted session, and
    // bumping historyRevision would re-marshal the whole transcript per step.
    const id = session();
    beginLiveTurn(id);
    const before = readLiveTurn(id)!.historyRevision;
    applyLoopEvent(id, { type: "step-usage", data: { usage: { inputTokens: 1 }, breakdown: {} } });
    expect(readLiveTurn(id)?.historyRevision).toBe(before);
    clearLiveTurn(id);
  });
});

describe("a turn that failed", () => {
  it("reads the provider's own message out of an API error", () => {
    // JSON.stringify on this shape is kilobytes of request dump with the one
    // readable line buried inside responseBody.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, {
      type: "error",
      data: {
        name: "AI_APICallError",
        message: "the whole request, system prompt and every tool definition",
        statusCode: 401,
        responseBody: JSON.stringify({ error: { message: "invalid x-api-key" } }),
      },
    });
    expect(readLiveTurn(id)?.error).toBe("invalid x-api-key (HTTP 401)");
    clearLiveTurn(id);
  });

  it("reads a plain Error the RPC server flattened", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "error", data: { name: "Error", message: "loop exited" } });
    expect(readLiveTurn(id)?.error).toBe("loop exited");
    clearLiveTurn(id);
  });

  it("says something rather than printing empty braces", () => {
    // What an older loop sends: an Error serialised by JSON, i.e. `{}`.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "error", data: {} });
    expect(readLiveTurn(id)?.error).toBe("the call failed");
    clearLiveTurn(id);
  });
});

describe("the event seq", () => {
  it("tracks the highest applied, so an attach can resume from it", () => {
    const id = session();
    beginLiveTurn(id);
    expect(lastEventSeq(id)).toBe(0);
    clearLiveTurn(id);
  });

  it("survives the turn it was seen on being cleared", () => {
    // The counter is the server's, not the turn's — rewinding it would replay
    // events already rendered.
    const id = session();
    beginLiveTurn(id);
    clearLiveTurn(id);
    expect(lastEventSeq(id)).toBe(0);
    forgetEventSeq(id);
  });
});

describe("adopting a turn this client did not start", () => {
  it("opens a running turn when there is none", () => {
    const id = session();
    adoptRunningTurn(id);
    expect(readLiveTurn(id)?.running).toBe(true);
    clearLiveTurn(id);
  });

  it("revives one that a stale replayed finish had closed", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "finish", data: {} });
    expect(readLiveTurn(id)?.running).toBe(false);
    adoptRunningTurn(id);
    expect(readLiveTurn(id)?.running).toBe(true);
    clearLiveTurn(id);
  });
});

describe("a tool call with no tool-input-start", () => {
  it("still splits the text around it, in stream order", () => {
    // Native agents (Cursor) report a call only once it has run. Before the
    // fix, the sentence after the tool streamed into the run above it, and the
    // tool only moved into place once the turn was persisted.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "text-delta", data: "Reading the note." });
    applyLoopEvent(id, {
      type: "tool-call",
      data: { toolCallId: "c1", toolName: "read", input: { path: "note.txt" } },
    });
    applyLoopEvent(id, { type: "text-delta", data: "The word is banana." });
    const turn = readLiveTurn(id);
    expect(turn?.texts.map((run) => run.text)).toEqual(["Reading the note.", "The word is banana."]);
    const [before, after] = turn?.texts ?? [];
    const tool = turn?.tools[0];
    expect(before!.seq < tool!.seq && tool!.seq < after!.seq).toBe(true);
    clearLiveTurn(id);
  });
});

describe("overlapping sends from the queue", () => {
  it("a refused send never overwrites the turn a newer send opened", () => {
    // MEASURED: QB's drain began first (displacing the finished essay turn),
    // Esc's send-now for QA began next and was accepted, then QB was refused.
    // Restoring what QB displaced put the essay back, and QA's reply streamed
    // onto the end of the essay.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "text-delta", data: "Essay text" });
    const qb = beginLiveTurn(id);
    const qa = beginLiveTurn(id);
    abandonLiveTurn(id, qb); // refused, but QA owns the slot now
    applyLoopEvent(id, { type: "text-delta", data: "PINEAPPLE" });
    expect(readLiveTurn(id)).toBe(qa);
    expect(liveTurnText(readLiveTurn(id)!)).toBe("PINEAPPLE");
    clearLiveTurn(id);
  });

  it("rolls back past other refused sends to the real turn", () => {
    const id = session();
    const running = beginLiveTurn(id);
    applyLoopEvent(id, { type: "text-delta", data: "still going" });
    const first = beginLiveTurn(id);
    const second = beginLiveTurn(id);
    abandonLiveTurn(id, first); // not current: no-op, marked abandoned
    abandonLiveTurn(id, second); // current: restores past `first` to `running`
    expect(readLiveTurn(id)).toBe(running);
    clearLiveTurn(id);
  });
});

describe("consecutive turns with no beginLiveTurn between them", () => {
  it("starts a new turn instead of extending the ended one", () => {
    // A replay after reload, or a turn a queue drain started: events arrive
    // back to back with only `finish` between them.
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "text-delta", data: "The essay, cut off" });
    applyLoopEvent(id, { type: "finish", data: {} });
    applyLoopEvent(id, { type: "text-delta", data: "KIWI" });
    expect(liveTurnText(readLiveTurn(id)!)).toBe("KIWI");
    expect(readLiveTurn(id)?.running).toBe(true);
    clearLiveTurn(id);
  });

  it("still lets a recap attach to the turn that just ended", () => {
    const id = session();
    beginLiveTurn(id);
    applyLoopEvent(id, { type: "text-delta", data: "Done." });
    applyLoopEvent(id, { type: "finish", data: {} });
    applyLoopEvent(id, { type: "data-recap", data: { text: "Summary" } });
    expect(liveTurnText(readLiveTurn(id)!)).toBe("Done.");
    clearLiveTurn(id);
  });
});
