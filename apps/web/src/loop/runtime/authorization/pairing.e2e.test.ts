import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { resolveRemotePairingTarget } from "@loop/shared/remote";

import { createSocketHost } from "../../transport.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";

/**
 * The client runtime the web and mobile apps share, pairing with a real
 * `loop serve` (packages/core/src/rpc/serve-pairing.ts) — every response
 * decoded by the client's own schemas, then a socket opened with the ticket.
 *
 * Opt-in, because it needs one running:
 *
 *   loop serve --host 127.0.0.1 --port 5701 &
 *   LOOP_E2E_PAIRING_URL="http://127.0.0.1:5701/?token=…" \
 *     vp test run --project unit src/loop/runtime/authorization/pairing.e2e.test.ts
 */
const pairingUrl = process.env.LOOP_E2E_PAIRING_URL ?? "";

describe.skipIf(pairingUrl === "")("pairing with a live loop serve", () => {
  it("pairs, gets a ticket, and talks to loop over the socket it opens", async () => {
    const target = resolveRemotePairingTarget({ pairingUrl });

    const { descriptor, socketUrl, session } = await Effect.runPromise(
      Effect.gen(function* () {
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: target.httpBaseUrl });
        const access = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: target.httpBaseUrl,
          credential: target.credential,
        });
        const session = yield* fetchRemoteSessionState({
          httpBaseUrl: target.httpBaseUrl,
          bearerToken: access.access_token,
        });
        const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: target.wsBaseUrl,
          httpBaseUrl: target.httpBaseUrl,
          bearerToken: access.access_token,
        });
        return { descriptor, socketUrl, session };
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch))),
    );

    expect(descriptor.environmentId).toMatch(/^loop-/);
    expect(session.authenticated).toBe(true);
    // The socket URL carries a one-use ticket, never the token itself.
    expect(socketUrl).toContain("wsTicket=");
    expect(socketUrl).not.toContain(target.credential);

    const host = createSocketHost(descriptor.environmentId, socketUrl);
    try {
      const info = await host.call<{ defaults?: { cwd?: string } }>("server.info");
      expect(typeof info).toBe("object");
    } finally {
      host.close();
    }
  });
});
