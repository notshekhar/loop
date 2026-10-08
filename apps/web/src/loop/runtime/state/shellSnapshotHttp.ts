import type { OrchestrationShellSnapshot } from "@loop/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

// Bounded so a pathologically slow endpoint cannot block the (cheaper) socket
// fallback for long. The cached shell renders while this runs.
const DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS = 6_000;

/**
 * Load the environment shell snapshot (projects + thread shells) over HTTP
 * instead of as the WebSocket subscription's first frame. The response is
 * gzip-compressible by the transport and keeps the (potentially large) list off
 * the socket.
 */
export const fetchEnvironmentShellSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentShellSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/orchestration/shell");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.shellSnapshot({ headers }),
    ),
  );
});

/**
 * Loads the environment shell snapshot over HTTP, returning `Option.none()` when
 * it cannot be loaded (so the caller falls back to the socket-embedded snapshot).
 * Decouples the shell state machine from the underlying HTTP + DPoP details and
 * keeps them out of test contexts.
 */
export class ShellSnapshotLoader extends Context.Service<
  ShellSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<OrchestrationShellSnapshot>>;
  }
>()("@loop/runtime/state/shellSnapshotHttp/ShellSnapshotLoader") {}

/**
 * loop's hosts serve no HTTP snapshot endpoint: the snapshot is built from
 * loop's own RPC by the handlers this client runs (handlers/), and arrives as
 * the subscription's first frame. So the loader declines at once rather than
 * asking — asking cost every connect a failed, CORS-refused request and a
 * warning before the same fallback. `fetchEnvironment*Snapshot` stays for an
 * upstream-shaped server.
 */
export const shellSnapshotLoaderLayer: Layer.Layer<ShellSnapshotLoader> = Layer.succeed(
  ShellSnapshotLoader,
  ShellSnapshotLoader.of({
    load: (_prepared: PreparedConnection) => Effect.succeed(Option.none<OrchestrationShellSnapshot>()),
  }),
);
