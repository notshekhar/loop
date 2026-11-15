import * as Option from "effect/Option";
import { useMemo } from "react";

import type { EnvironmentPresentation } from "~/state/environments";
import { formatDesktopSshTarget } from "./sshTargets";

function indexSshEnvironmentsByAlias(
  savedEnvironments: ReadonlyArray<EnvironmentPresentation>,
): Record<string, EnvironmentPresentation> {
  return savedEnvironments.reduce<Record<string, EnvironmentPresentation>>(
    (accumulator, environment) => {
      const profile = environment.entry.profile;
      if (
        environment.entry.target._tag === "SshConnectionTarget" &&
        Option.isSome(profile) &&
        profile.value._tag === "SshConnectionProfile"
      ) {
        accumulator[profile.value.target.alias] = environment;
      }
      return accumulator;
    },
    {},
  );
}

function collectSshEnvironmentKeys(
  savedEnvironments: ReadonlyArray<EnvironmentPresentation>,
): Set<string> {
  const keys = new Set<string>();
  for (const environment of savedEnvironments) {
    const profile = environment.entry.profile;
    if (
      environment.entry.target._tag !== "SshConnectionTarget" ||
      Option.isNone(profile) ||
      profile.value._tag !== "SshConnectionProfile"
    ) {
      continue;
    }
    const target = profile.value.target;
    keys.add(target.alias);
    keys.add(formatDesktopSshTarget(target));
  }
  return keys;
}

/** Every environment except the primary, plus the SSH lookups the add-host flow needs. */
export function useSavedEnvironments(environments: ReadonlyArray<EnvironmentPresentation>) {
  const savedEnvironments = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.target._tag !== "PrimaryConnectionTarget")
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments],
  );
  const savedDesktopSshEnvironmentsByAlias = useMemo(
    () => indexSshEnvironmentsByAlias(savedEnvironments),
    [savedEnvironments],
  );
  const savedDesktopSshEnvironmentKeys = useMemo(
    () => collectSshEnvironmentKeys(savedEnvironments),
    [savedEnvironments],
  );
  return { savedEnvironments, savedDesktopSshEnvironmentsByAlias, savedDesktopSshEnvironmentKeys };
}
