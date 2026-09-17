import {
  LOOP_PROJECT_FILE_NAME,
  type EnvironmentId,
  type LoopProjectFileScript,
} from "@loop/contracts";
import { LoopProjectFileFromJson } from "@loop/shared/loopProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeLoopProjectFile = Schema.decodeExit(LoopProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<LoopProjectFileScript> = [];

/**
 * Scripts declared in the project's checked-in `loop.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useLoopProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<LoopProjectFileScript> {
  const query = useProjectFileQuery(environmentId, cwd ?? "", LOOP_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return NO_SCRIPTS;
    const decoded = decodeLoopProjectFile(contents);
    if (Exit.isFailure(decoded)) return NO_SCRIPTS;
    return decoded.value.scripts ?? NO_SCRIPTS;
  }, [contents]);
}
