// Scratch probe (deleted after use): what the phone's handlers emit during
// one streamed turn — every thread snapshot, when, and how much text.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createSocketHost } from "./src/loop/transport.ts";
import { threadStream } from "./src/loop/handlers/thread.ts";
import { subscribeLiveTurns } from "./src/loop/handlers/liveTurn.ts";

const token = process.argv[2]!;
const host = createSocketHost("probe", () => `ws://127.0.0.1:5710/ws?token=${token}`, { reconnect: false });
subscribeLiveTurns(host);
const { sessionId } = await host.call<{ sessionId: string }>("session.create", { cwd: process.argv[3], provider: "custom:fixture", model: "custom:fixture/fixture" });
const t0 = performance.now();
let n = 0;
const fiber = Effect.runFork(
  Stream.runForEach(threadStream(sessionId, host), (item) =>
    Effect.sync(() => {
      if (item.kind !== "snapshot") return;
      const t = item.snapshot.thread;
      const last = t.messages.at(-1);
      n++;
      console.log(`+${(performance.now() - t0).toFixed(0)}ms snapshot#${n} msgs=${t.messages.length} acts=${t.activities.length} lastRole=${last?.role} streaming=${last?.streaming} textLen=${last?.text.length ?? 0} turn=${t.latestTurn?.state ?? "-"} session=${t.session?.status ?? "-"}`);
    }),
  ),
);
await Bun.sleep(800);
console.log("send");
await host.call("session.send", { sessionId, input: "please stream", model: "custom:fixture/fixture" });
await Bun.sleep(16000);
console.log(`total snapshots: ${n}`);
host.close();
process.exit(0);
