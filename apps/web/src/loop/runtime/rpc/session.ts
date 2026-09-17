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
 * The client/server wiring is inlined from `effect/unstable/rpc/RpcTest.ts`
 * (the `let client` closure is what breaks the server↔client cycle) rather
 * than imported, because that module is documented as a test harness.
 */
import { type ServerConfig, WsRpcGroup, WS_METHODS } from "@loop/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { makeHandlers } from "../../handlers/index.ts";
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

const makeInProcessClient = Effect.fnUntraced(function* (connection: PreparedConnection) {
  const handlers = makeHandlers({
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
  return client.client as WsRpcProtocolClient;
});

export const make = Effect.gen(function* () {
  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const client = yield* makeInProcessClient(connection);
    // There is no socket to open, so the connection is live the moment the
    // handlers are wired. The supervisor above still waits on this deferred.
    yield* Deferred.succeed(connected, undefined);
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
