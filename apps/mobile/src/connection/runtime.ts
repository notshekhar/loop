import { Connection } from "@loop/runtime/connection";
import { shellSnapshotLoaderLayer } from "@loop/runtime/state/shell";
import { threadSnapshotLoaderLayer } from "@loop/runtime/state/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import {
  mobileBackgroundActivityObserverLayer,
  mobileBackgroundActivityReporterLayer,
} from "./background-activity";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.merge(threadSnapshotLoaderLayer, shellSnapshotLoaderLayer);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof mobileBackgroundActivityObserverLayer
  | typeof mobileBackgroundActivityReporterLayer;

const providedClientConnectionLayer = Layer.merge(Connection.layer, snapshotLoaderLayer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      mobileBackgroundActivityObserverLayer,
    ),
  ),
);

const connectionLayer = mobileBackgroundActivityReporterLayer.pipe(
  Layer.provideMerge(providedClientConnectionLayer),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.keepAlive(Atom.runtime(connectionLayer));
// Kept alive: the connection layer is the app's one registry of machines and
// their supervisors, and it lives as long as the app. Left to the default, the
// runtime was disposed whenever its subscribers dipped to zero while the first
// screens mounted, and built again — MEASURED three builds at launch, two of
// them each running a supervisor for the same machine: two prepares, two
// tickets, two sockets, and a first connect stalled behind the contention.
