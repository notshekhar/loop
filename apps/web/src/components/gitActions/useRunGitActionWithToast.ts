import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@loop/contracts";
import { useEffectEvent } from "react";
import {
  buildGitActionProgressStages,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
} from "~/components/GitActionsControl.logic";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import type { useGitStackedAction } from "~/lib/sourceControlActions";
import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import type { getSourceControlPresentation } from "~/sourceControlPresentation";
import { gitErrorToast } from "./gitActionToasts";
import {
  type ActiveGitActionProgressRef,
  applyGitActionProgressEvent,
  type GitActionToastId,
} from "./useGitActionProgressToast";

export interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

export interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
}

export type RunGitActionWithToast = (input: RunGitActionWithToastInput) => Promise<void>;

type ActionStatus = VcsStatusResult | null;
type ToastCta = GitRunStackedActionResult["toast"]["cta"];

const DEFAULT_PROGRESS_TITLE = "Running git action...";

/** "run" proceeds, "abort" drops the action, a pending action asks the user first. */
function resolveDefaultBranchGate(
  input: RunGitActionWithToastInput,
  actionStatus: ActionStatus,
  isDefaultRef: boolean,
): "run" | "abort" | PendingDefaultBranchAction {
  const { action, commitMessage, onConfirmed, filePaths } = input;
  const { skipDefaultBranchPrompt = false, featureBranch = false } = input;
  const actionBranch = actionStatus?.refName ?? null;
  const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
  const actionCanCommit =
    action === "commit" || action === "commit_push" || action === "commit_push_pr";
  const includesCommit =
    actionCanCommit &&
    (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
  if (
    skipDefaultBranchPrompt ||
    !requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) ||
    !actionBranch
  ) {
    return "run";
  }
  if (
    action !== "push" &&
    action !== "create_pr" &&
    action !== "commit_push" &&
    action !== "commit_push_pr"
  ) {
    return "abort";
  }
  return {
    action,
    branchName: actionBranch,
    includesCommit,
    ...(commitMessage ? { commitMessage } : {}),
    ...(onConfirmed ? { onConfirmed } : {}),
    ...(filePaths ? { filePaths } : {}),
  };
}

/** Opens (or adopts) the loading toast and records the action as the one in flight. */
function beginGitActionProgress(
  progressRef: ActiveGitActionProgressRef,
  input: {
    progressToastId: GitActionToastId | undefined;
    title: string;
    scopedToastData: ThreadToastData | undefined;
    actionId: string;
  },
): GitActionToastId {
  const { progressToastId, title, scopedToastData, actionId } = input;
  const loadingToast = {
    type: "loading" as const,
    title,
    description: "Waiting for Git...",
    timeout: 0,
    data: scopedToastData,
  };
  const resolvedProgressToastId = progressToastId ?? toastManager.add(loadingToast);

  progressRef.current = {
    toastId: resolvedProgressToastId,
    toastData: scopedToastData,
    actionId,
    title,
    phaseStartedAtMs: null,
    hookStartedAtMs: null,
    hookName: null,
    lastOutputLine: null,
    currentPhaseLabel: title,
  };

  if (progressToastId) {
    toastManager.update(progressToastId, loadingToast);
  }
  return resolvedProgressToastId;
}

function createProgressEventHandler(
  progressRef: ActiveGitActionProgressRef,
  gitCwd: string | null,
  updateActiveProgressToast: () => void,
) {
  return (event: GitActionProgressEvent) => {
    const progress = progressRef.current;
    if (!progress) {
      return;
    }
    if (gitCwd && event.cwd !== gitCwd) {
      return;
    }
    if (progress.actionId !== event.actionId) {
      return;
    }
    if (applyGitActionProgressEvent(progress, event, Date.now())) {
      updateActiveProgressToast();
    }
  };
}

function buildToastCtaProps(
  toastCta: ToastCta,
  closeResultToast: () => void,
  rerun: (action: GitStackedAction) => void,
): { children: string; onClick: () => void } | null {
  if (toastCta.kind === "run_action") {
    return {
      children: toastCta.label,
      onClick: () => {
        closeResultToast();
        rerun(toastCta.action.kind);
      },
    };
  }
  if (toastCta.kind === "open_pr") {
    return {
      children: toastCta.label,
      onClick: () => {
        const api = readLocalApi();
        if (!api) return;
        closeResultToast();
        void api.shell.openExternal(toastCta.url);
      },
    };
  }
  return null;
}

/** An interrupted action just drops its toast; a real failure turns it into the error. */
function showGitActionFailure(
  toastId: GitActionToastId,
  result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
  scopedToastData: ThreadToastData | undefined,
): void {
  if (isAtomCommandInterrupted(result)) {
    toastManager.close(toastId);
    return;
  }
  const error = squashAtomCommandFailure(result);
  toastManager.update(toastId, gitErrorToast("Action failed", error, scopedToastData));
}

function showGitActionSuccess(
  toastId: GitActionToastId,
  actionResult: GitRunStackedActionResult,
  scopedToastData: ThreadToastData | undefined,
  rerun: (action: GitStackedAction) => void,
): void {
  const toastActionProps = buildToastCtaProps(
    actionResult.toast.cta,
    () => toastManager.close(toastId),
    rerun,
  );
  const successToastData = {
    ...scopedToastData,
    dismissAfterVisibleMs: 10_000,
  };

  if (toastActionProps) {
    toastManager.update(
      toastId,
      stackedThreadToast({
        type: "success",
        title: actionResult.toast.title,
        description: actionResult.toast.description,
        timeout: 0,
        actionProps: toastActionProps,
        data: successToastData,
      }),
    );
  } else {
    toastManager.update(toastId, {
      type: "success",
      title: actionResult.toast.title,
      description: actionResult.toast.description,
      timeout: 0,
      data: successToastData,
    });
  }
}

interface RunGitActionDeps {
  readonly gitCwd: string | null;
  readonly gitStatusForActions: ActionStatus;
  readonly isDefaultRef: boolean;
  readonly changeRequestTerminology: ReturnType<typeof getSourceControlPresentation>["terminology"];
  readonly threadToastData: ThreadToastData | undefined;
  readonly activeGitActionProgressRef: ActiveGitActionProgressRef;
  readonly updateActiveProgressToast: () => void;
  readonly runImmediateGitAction: ReturnType<typeof useGitStackedAction>;
  readonly syncThreadBranchAfterGitAction: (result: GitRunStackedActionResult) => void;
  readonly setPendingDefaultBranchAction: (action: PendingDefaultBranchAction) => void;
}

/**
 * Runs a stacked git action behind a progress toast: asks first on the default
 * branch, streams hook output into the toast, then settles it as success or error.
 */
export function useRunGitActionWithToast(deps: RunGitActionDeps): RunGitActionWithToast {
  const runGitActionWithToast: RunGitActionWithToast = useEffectEvent(
    async (input: RunGitActionWithToastInput) => {
      const { action, commitMessage, onConfirmed, progressToastId, filePaths } = input;
      const { featureBranch = false } = input;
      const actionStatus = input.statusOverride ?? deps.gitStatusForActions;
      const gate = resolveDefaultBranchGate(input, actionStatus, deps.isDefaultRef);
      if (gate === "abort") return;
      if (gate !== "run") {
        deps.setPendingDefaultBranchAction(gate);
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        terminology: deps.changeRequestTerminology,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      });
      const scopedToastData = deps.threadToastData ? { ...deps.threadToastData } : undefined;
      const actionId = randomUUID();
      const resolvedProgressToastId = beginGitActionProgress(deps.activeGitActionProgressRef, {
        progressToastId,
        title: progressStages[0] ?? DEFAULT_PROGRESS_TITLE,
        scopedToastData,
        actionId,
      });

      const result = await deps.runImmediateGitAction.run({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        onProgress: createProgressEventHandler(
          deps.activeGitActionProgressRef,
          deps.gitCwd,
          deps.updateActiveProgressToast,
        ),
      });

      deps.activeGitActionProgressRef.current = null;
      if (result._tag === "Failure") {
        showGitActionFailure(resolvedProgressToastId, result, scopedToastData);
        return;
      }

      deps.syncThreadBranchAfterGitAction(result.value);
      showGitActionSuccess(resolvedProgressToastId, result.value, scopedToastData, (next) => {
        void runGitActionWithToast({ action: next });
      });
    },
  );
  return runGitActionWithToast;
}
