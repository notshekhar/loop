import { EnvironmentId, type TeamSnapshot } from "@loop/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../../../state/query";
import { teamAtoms } from "../../../state/team";

/** The team a thread is in, live from its host — null while it is in none. */
export function useThreadTeam(
  environmentId: string | null,
  threadId: string | null,
): TeamSnapshot | null {
  const atom = useMemo(
    () =>
      environmentId && threadId
        ? teamAtoms.team({ environmentId: EnvironmentId.make(environmentId), input: { threadId } })
        : null,
    [environmentId, threadId],
  );
  return useEnvironmentQuery(atom).data ?? null;
}
