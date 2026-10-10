import { WS_METHODS } from "@loop/contracts";
import { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * A thread's team, live (`subscribeTeam`), and the panel's Stop button
 * (`team.stop`). See loop/handlers/team.ts.
 */
export function createTeamAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    team: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:team",
      tag: WS_METHODS.subscribeTeam,
      idleTtlMs: 30_000,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:stop",
      tag: WS_METHODS.teamStop,
    }),
    /** The host's threadTeams switch — the phone's Settings row. */
    setting: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:team:setting",
      tag: WS_METHODS.teamSettingGet,
      staleTimeMs: 10_000,
    }),
    setSetting: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:setting:set",
      tag: WS_METHODS.teamSettingSet,
    }),
  };
}
