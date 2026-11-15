import type { ScopedThreadRef } from "@loop/contracts";
import { safeErrorLogAttributes } from "@loop/runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import { useCallback } from "react";
import { openDiffFilePrimaryAction } from "../../diffFileActions";
import type { useOpenInPreferredEditor } from "../../editorPreferences";

/** Opens a file from the diff, in the preview or the user's editor. */
export function useOpenDiffFile(
  routeThreadRef: ScopedThreadRef | null,
  activeCwd: string | undefined,
  openInPreferredEditor: ReturnType<typeof useOpenInPreferredEditor>,
) {
  return useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    },
    [activeCwd, openInPreferredEditor, routeThreadRef],
  );
}
