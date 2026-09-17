/**
 * PORTED FOR loop. Upstream's version of this file was 478 lines covering an
 * HTTP auth handshake that loop does not have: silent desktop bootstrap,
 * pairing tokens taken from the URL, bearer exchange, proxy base resolution,
 * and retry-after-restart. All of it existed to decide whether the browser was
 * allowed to talk to the upstream server over the network.
 *
 * loop settles that before the app starts. `loop serve` checks its token on the
 * WebSocket upgrade, and the desktop shell talks to a `loop rpc` process it
 * spawned itself — so there is no second party to authenticate against and no
 * credential for the UI to hold. Keeping the old assertions would have meant
 * testing a flow that can no longer run.
 *
 * What is worth pinning is what replaced it: the gate opens locally, every
 * time, with the scopes the app needs, and it never touches the network.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  __resetServerAuthBootstrapForTests,
  fetchSessionState,
  resolveInitialServerAuthGateState,
} from "./environments/primary/auth";

describe("the local auth gate", () => {
  it("reports an authenticated session without making a request", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return realFetch(...args);
    }) as typeof fetch;
    try {
      const session = await fetchSessionState();
      expect(session.authenticated).toBe(true);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("grants the scopes the app needs to operate, not only to read", async () => {
    const session = await fetchSessionState();
    // Without the operate scopes the composer renders but cannot dispatch.
    expect(session.scopes).toContain("orchestration:read");
    expect(session.scopes).toContain("orchestration:operate");
    expect(session.scopes).toContain("terminal:operate");
  });

  it("declares the policy that stops the UI offering a sign-in", async () => {
    const session = await fetchSessionState();
    expect(session.auth.policy).toBe("desktop-managed-local");
    expect(session.auth.bootstrapMethods).toEqual([]);
  });

  it("opens the initial gate as authenticated", async () => {
    __resetServerAuthBootstrapForTests();
    const state = await resolveInitialServerAuthGateState();
    expect(state.status).toBe("authenticated");
  });
});
