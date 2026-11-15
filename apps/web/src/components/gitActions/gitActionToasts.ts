import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import type { useVcsInitAction, useVcsPullAction } from "~/lib/sourceControlActions";

/** Error toast in the stacked layout, so long git errors keep their copy action. */
export function gitErrorToast(
  title: string,
  error: unknown,
  threadToastData: ThreadToastData | undefined,
) {
  return stackedThreadToast({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
    ...(threadToastData !== undefined ? { data: threadToastData } : {}),
  });
}

export function runPullWithToast(
  pullAction: ReturnType<typeof useVcsPullAction>,
  threadToastData: ThreadToastData | undefined,
): void {
  const toastId = toastManager.add({
    type: "loading",
    title: "Pulling...",
    timeout: 0,
    data: threadToastData,
  });
  void (async () => {
    const result = await pullAction.run();
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        toastManager.close(toastId);
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.update(toastId, gitErrorToast("Pull failed", error, threadToastData));
      return;
    }

    const pullResult = result.value;
    toastManager.update(toastId, {
      type: "success",
      title: pullResult.status === "pulled" ? "Pulled" : "Already up to date",
      description:
        pullResult.status === "pulled"
          ? `Updated ${pullResult.refName} from ${pullResult.upstreamRef ?? "upstream"}`
          : `${pullResult.refName} is already synchronized.`,
      data: threadToastData,
    });
  })();
}

export function runInitWithToast(
  initAction: ReturnType<typeof useVcsInitAction>,
  threadToastData: ThreadToastData | undefined,
): void {
  void (async () => {
    const result = await initAction.run();
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
      return;
    }
    const error = squashAtomCommandFailure(result);
    toastManager.add(gitErrorToast("Git initialization failed", error, threadToastData));
  })();
}
