import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { LoopHost } from "../transport.ts";
import { forgetHistoriesForTests, readHistory } from "./thread.ts";

/**
 * Re-reading a session refetches only its tail (`afterEntryId`): a long
 * session is hundreds of KB, and a phone re-reading it whole at every tool
 * step fell behind the turn until it ended.
 */
function host(entries: Array<{ id?: string; type: string; ts: number }>, opts: { tails: boolean }) {
  const asked: Array<string | undefined> = [];
  const h = {
    id: "h",
    call: async (_method: string, params: { afterEntryId?: string }) => {
      asked.push(params.afterEntryId);
      const at = opts.tails && params.afterEntryId ? entries.findIndex((e) => e.id === params.afterEntryId) : -1;
      return {
        sessionId: "s",
        info: { cwd: "/", provider: "p", model: "m", createdAt: 0 },
        entries: at >= 0 ? entries.slice(at + 1) : [...entries],
        ...(at >= 0 ? { tail: { afterEntryId: params.afterEntryId } } : {}),
        seq: 0,
        running: false,
      };
    },
  };
  return { host: h as unknown as LoopHost, asked };
}

const entry = (n: number) => ({ id: `e${n}`, type: "message", ts: n });

describe("history tails", () => {
  beforeEach(() => forgetHistoriesForTests());

  it("asks for the tail after the first read, and merges it into the whole branch", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i));
    const { host: h, asked } = host(entries, { tails: true });
    const first = await readHistory(h, "s");
    expect(first.entries).toHaveLength(10);
    entries.push(entry(10), entry(11));
    const second = await readHistory(h, "s");
    expect(asked).toEqual([undefined, "e5"]); // anchored a few entries back
    expect(second.entries.map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it("an older host ignores the tail and its whole answer replaces what was held", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i));
    const { host: h } = host(entries, { tails: false });
    await readHistory(h, "s");
    entries.splice(3, 7, entry(42)); // a branch switch
    const again = await readHistory(h, "s");
    expect(again.entries.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e42"]);
  });
});
