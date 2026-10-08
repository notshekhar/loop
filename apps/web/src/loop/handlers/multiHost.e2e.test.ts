import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { createSocketHost } from "../transport.ts";
import { buildServerConfig } from "./serverConfig.ts";
import { buildShellSnapshot } from "./shell.ts";

/**
 * The handlers against two real `loop serve` processes, over real sockets.
 *
 * Opt-in, because it needs them running:
 *
 *   (cd /tmp/a && loop serve --host 127.0.0.1 --port 5701) &
 *   (cd /tmp/b && loop serve --host 127.0.0.1 --port 5702) &
 *   LOOP_E2E_HOSTS="ws://127.0.0.1:5701/ws?token=…,ws://127.0.0.1:5702/ws?token=…" \
 *     vp test run --project unit src/loop/handlers/multiHost.e2e.test.ts
 *
 * Started from different folders so each host reports a different anchor.
 */
const urls = (process.env.LOOP_E2E_HOSTS ?? "").split(",").filter(Boolean);

describe.skipIf(urls.length < 2)("two live loop hosts", () => {
  it("builds each host's environment from that host", async () => {
    const [a, b] = urls.map((url, index) => createSocketHost(`host-${index}`, url));
    try {
      const configs = await Promise.all(
        [a!, b!].map((host) =>
          Effect.runPromise(
            buildServerConfig({ host, cwd: "/", environmentId: host.id, label: host.id }),
          ),
        ),
      );
      const [cwdA, cwdB] = configs.map((config) => config.cwd);
      expect(cwdA).not.toBe(cwdB);
      expect(configs.every((config) => config.providers.length > 0)).toBe(true);

      // The shell is each host's own `session.list`.
      const shells = await Promise.all(
        [a!, b!].map((host) => Effect.runPromise(buildShellSnapshot(false, host))),
      );
      expect(shells.every((shell) => Array.isArray(shell.projects))).toBe(true);
    } finally {
      a!.close();
      b!.close();
    }
  });
});
