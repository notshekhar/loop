import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, VcsStatusResult } from "@loop/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import { useCallback } from "react";
import { toastManager, type ThreadToastData } from "~/components/ui/toast";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { openPullRequestLink } from "~/lib/openPullRequestLink";
import { readLocalApi } from "~/localApi";
import { serverEnvironment } from "~/state/server";
import { resolvePathLinkTarget } from "~/terminal-links";
import { gitErrorToast } from "./gitActionToasts";

interface GitActionLinksInput {
  readonly activeEnvironmentId: ScopedThreadRef["environmentId"] | null;
  readonly gitCwd: string | null;
  readonly gitStatusForActions: VcsStatusResult | null;
  readonly threadToastData: ThreadToastData | undefined;
}

/** Opening things outside the control: the branch's open PR, or a changed file in the editor. */
export function useGitActionLinks({
  activeEnvironmentId,
  gitCwd,
  gitStatusForActions,
  threadToastData,
}: GitActionLinksInput) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(activeEnvironmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );

  const openExistingPr = useCallback(async () => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open pull request found.",
        data: threadToastData,
      });
      return;
    }
    void openPullRequestLink(api.shell, prUrl).catch((err: unknown) => {
      console.error(err);
      toastManager.add(gitErrorToast("Unable to open pull request link", err, threadToastData));
    });
  }, [gitStatusForActions, threadToastData]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void (async () => {
        const result = await openInPreferredEditor(target);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(gitErrorToast("Unable to open file", error, threadToastData));
      })();
    },
    [gitCwd, openInPreferredEditor, threadToastData],
  );

  return { openExistingPr, openChangedFileInEditor };
}
