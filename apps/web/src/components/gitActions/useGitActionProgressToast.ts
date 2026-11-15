import type { GitActionProgressEvent } from "@loop/contracts";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { toastManager, type ThreadToastData } from "~/components/ui/toast";
import { useDocumentVisible } from "~/hooks/useDocumentVisible";

export type GitActionToastId = ReturnType<typeof toastManager.add>;

export interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

export type ActiveGitActionProgressRef = RefObject<ActiveGitActionProgress | null>;

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

/**
 * Folds one progress event into `progress` in place. Returns whether the toast
 * should be redrawn.
 */
export function applyGitActionProgressEvent(
  progress: ActiveGitActionProgress,
  event: GitActionProgressEvent,
  now: number,
): boolean {
  switch (event.kind) {
    case "action_started":
      progress.phaseStartedAtMs = now;
      progress.hookStartedAtMs = null;
      progress.hookName = null;
      progress.lastOutputLine = null;
      break;
    case "phase_started":
      progress.title = event.label;
      progress.currentPhaseLabel = event.label;
      progress.phaseStartedAtMs = now;
      progress.hookStartedAtMs = null;
      progress.hookName = null;
      progress.lastOutputLine = null;
      break;
    case "hook_started":
      progress.title = `Running ${event.hookName}...`;
      progress.hookName = event.hookName;
      progress.hookStartedAtMs = now;
      progress.lastOutputLine = null;
      break;
    case "hook_output":
      progress.lastOutputLine = event.text;
      break;
    case "hook_finished":
      progress.title = progress.currentPhaseLabel ?? "Committing...";
      progress.hookName = null;
      progress.hookStartedAtMs = null;
      progress.lastOutputLine = null;
      break;
    case "action_finished":
      // Let the resolved mutation update the toast so we keep the
      // elapsed description visible until the final success state renders.
      return false;
    case "action_failed":
      // Let the settled mutation publish the error toast to avoid a
      // transient intermediate state before the final failure message.
      return false;
  }
  return true;
}

/** Owns the in-flight action's progress record and keeps its loading toast current. */
export function useGitActionProgressToast() {
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: progress.toastData,
    });
  }, []);

  // The toast's elapsed time only has to be right while someone can read it, so
  // the tick stops with the window and catches up on return.
  const documentVisible = useDocumentVisible();
  useEffect(() => {
    if (!documentVisible) return;
    const tick = () => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    };
    tick();
    const interval = window.setInterval(tick, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [documentVisible, updateActiveProgressToast]);

  return { activeGitActionProgressRef, updateActiveProgressToast };
}
