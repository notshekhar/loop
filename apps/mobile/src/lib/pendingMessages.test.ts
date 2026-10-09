import { describe, expect, it } from "vite-plus/test";

import { appendPendingMessages, isPendingMessageId } from "./pendingMessages";

describe("pending messages", () => {
  it("appear at the end of the thread as user rows, once each", () => {
    const rows = appendPendingMessages([], [
      { id: "m1", text: "first", createdAt: "2026-10-09T00:00:00.000Z" },
      { id: "m1", text: "first", createdAt: "2026-10-09T00:00:00.000Z" },
      { id: "m2", text: "second", createdAt: "2026-10-09T00:00:01.000Z" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["queued:m1", "queued:m2"]);
    const first = rows[0]!;
    expect(first.type === "message" && first.message.role).toBe("user");
    expect(first.type === "message" && isPendingMessageId(first.message.id)).toBe(true);
  });

  it("leave the feed untouched when nothing is waiting", () => {
    const feed: never[] = [];
    expect(appendPendingMessages(feed, [])).toBe(feed);
  });
});
