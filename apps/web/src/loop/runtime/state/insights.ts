import { WS_METHODS } from "@loop/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** A thread's context, cost and the host's token totals (`session.insights`). */
export function createSessionInsightsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:session:insights",
      tag: WS_METHODS.sessionInsights,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
  };
}
