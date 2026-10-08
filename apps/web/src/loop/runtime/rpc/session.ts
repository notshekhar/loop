/**
 * PORTED FOR loop. Upstream opened a WebSocket to its server here; loop
 * has no such server, so the client is wired **straight to in-process
 * handlers** with `RpcServer.makeNoSerialization` +
 * `RpcClient.makeNoSerialization`. No socket, no server process.
 *
 * This is the whole seam. Every one of the ~150 atoms above this file is a
 * thin wrapper over `RpcClient.make(WsRpcGroup)`, so all of the coupling to
 * upstream's server lived in the transport — replacing this one file leaves
 * the rest of the UI untouched, streams, acks and interrupts included.
 *
 * The client/server wiring is inlined from `effect/rpc/RpcTest.ts`
 * (the `let client` closure is what breaks the server↔client cycle) rather
 * than imported, because that module is documented as a test harness.
 */
import { type ServerConfig, WsRpcGroup, WS_METHODS } from "@loop/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcServer from "effect/rpc/RpcServer";

import { makeHandlers } from "../../handlers/index.ts";
import { handshake } from "../../protocol.ts";
import { createSocketHost, defaultLoopHost, type LoopHost } from "../../transport.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@loop/runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;

function mapSessionRpcError(error: InitialConfigError | ProbeError): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: error.message,
      });
  }
}

/**
 * A client bound directly to handlers in this process.
 *
 * Inlined from `RpcTest.makeClient`: the server writes responses into the
 * client and the client writes requests into the server, so `client` has to be
 * declared before the server that closes over it.
 */
const makeClient = () =>
  RpcClient.makeNoSerialization(WsRpcGroup, {
    supportsAck: true,
    onFromClient: () => Effect.void,
  });

/**
 * Which loop host an environment is.
 *
 * The primary environment is the page's own loop: the desktop's `loop rpc`, or
 * the `loop serve` that served this page. Any other environment is another
 * machine, dialed at the socket URL its connection was prepared with (the
 * token rides in that URL). A shell with its own idea — the mobile app, which
 * has no page host at all — provides its own resolver.
 */
export class LoopHostResolver extends Context.Reference<{
  readonly resolve: (connection: PreparedConnection) => Effect.Effect<LoopHost, never, Scope.Scope>;
}>("@loop/runtime/rpc/LoopHostResolver", {
  defaultValue: () => ({
    resolve: (connection) =>
      connection.target._tag === "PrimaryConnectionTarget"
        ? Effect.succeed(defaultLoopHost)
        : Effect.acquireRelease(
            // The URL carries a one-use ticket, so the socket does not redial
            // itself: its close ends this session and the supervisor prepares
            // the connection again, which mints a fresh ticket.
            Effect.sync(() =>
              createSocketHost(connection.environmentId, connection.socketUrl, { reconnect: false }),
            ),
            (host) => Effect.sync(() => host.close()),
          ),
  }),
}) {}

const makeInProcessClient = Effect.fnUntraced(function* (connection: PreparedConnection) {
  const resolver = yield* LoopHostResolver;
  const host = yield* resolver.resolve(connection);
  const handlers = makeHandlers({
    host,
    environmentId: connection.environmentId,
    label: connection.label,
    // Replaced by the folder loop reports from `server.info`; only used when
    // that call fails.
    cwd: "/",
  });

  // oxlint-disable-next-line prefer-const -- the server/client cycle needs it.
  let client: Effect.Success<ReturnType<typeof makeClient>>;
  const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
    onFromServer(response) {
      return client.write(response);
    },
  }).pipe(Effect.provide(handlers));
  client = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
    supportsAck: true,
    onFromClient({ message }) {
      return server.write(0, message);
    },
  });
  return { client: client.client as WsRpcProtocolClient, host };
});

export const make = Effect.gen(function* () {
  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const { client, host } = yield* makeInProcessClient(connection);
    // The handshake (packages/core/src/rpc/protocol.ts): an app and a host
    // that cannot talk say so now, naming the side to update, instead of
    // failing in some method later. Blocked, not retried — retrying cannot
    // change either side's version. Only for another machine: the page's own
    // host (the desktop's bundled loop, or the serve that sent this page)
    // ships with this app and cannot disagree with it.
    const handshook =
      host === defaultLoopHost
        ? ({ ok: true } as const)
        : yield* Effect.tryPromise({
            try: () => handshake((method, params) => host.call(method, params), "loop-app"),
            catch: (error) =>
              new ConnectionTransientErrorClass({
                reason: "transport",
                detail: `Could not reach ${connection.label}: ${error instanceof Error ? error.message : String(error)}`,
              }),
          });
    if (!handshook.ok) {
      return yield* Effect.fail(
        new ConnectionBlockedError({ reason: "configuration", detail: handshook.message }),
      );
    }
    // The handlers are live the moment they are wired; the supervisor above
    // still waits on this deferred.
    yield* Deferred.succeed(connected, undefined);
    // A host reached over its own socket can drop. Report that as this
    // session closing, so the supervisor reconnects — with a fresh ticket —
    // instead of the UI talking to a socket that is gone. The page's own
    // host (desktop bridge, same-origin serve) recovers by itself.
    if (host !== defaultLoopHost) {
      const unwatch = host.onConnectionChange((state) => {
        if (state !== "closed") return;
        Deferred.doneUnsafe(
          disconnected,
          Effect.fail(
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: `The connection to ${connection.label} closed.`,
            }),
          ),
        );
      });
      yield* Effect.addFinalizer(() => Effect.sync(unwatch));
    }
    const initialConfig = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapSessionRpcError),
        Effect.withSpan("environment.initialSync"),
      ),
    );
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? client[WS_METHODS.serverProbe]({})
          : client[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapSessionRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client,
      initialConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
