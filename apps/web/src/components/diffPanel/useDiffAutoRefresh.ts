import { useEffect, useRef } from "react";
import { useDocumentVisible } from "../../hooks/useDocumentVisible";

/**
 * How long the panel waits after something moves before re-reading the diff.
 *
 * A turn that writes five files ticks five times, and each refresh is a `git
 * diff` over the whole tree — so the ticks are collapsed into one read. Short
 * enough that a single edit still lands while the user is looking at it.
 */
const DIFF_REFRESH_DEBOUNCE_MS = 400;

/**
 * How often the panel re-reads the diff on its own while a turn is running.
 *
 * The event-driven triggers below are both coarser than a tool call. The
 * thread's `updatedAt` is loop's PERSISTED session timestamp, and loop writes
 * a step's messages in one transaction after the step ends
 * (`packages/core/src/agent/turn.ts`) — so an `edit` or `write` in the middle
 * of a step is invisible to it until the model has finished thinking about the
 * result, which on a long step is a minute of watching a diff that does not
 * move. Git status is content-derived but only polls every five seconds, and
 * only notices changes that move a file's line counts.
 *
 * So while the agent is working, the panel just looks. It is one `git diff`
 * against a tree that is already warm in the page cache, and it stops the
 * moment the turn does.
 */
const DIFF_REFRESH_WHILE_RUNNING_MS = 1_500;

interface DiffAutoRefreshInput {
  /** Re-reads the patch on screen. */
  readonly refresh: () => void;
  readonly threadRevision: string | null;
  readonly threadIsRunning: boolean;
  readonly workingTreeRevision: unknown;
  /** False for a turn's checkpoint diff, which cannot change. */
  readonly readsLiveTree: boolean;
}

/**
 * Re-read the diff as the thread works.
 *
 * The agent writing a file is invisible to these queries: each asks git once
 * and then holds that answer for as long as its inputs are unchanged. So
 * without this the panel keeps showing the working tree as it was when the
 * panel opened, and every file the agent touches while you watch it is
 * simply missing from the diff — which is what made the panel look frozen.
 *
 * Three things say "look again", because no one of them sees every write:
 *
 *   - the thread moving. `updatedAt` is loop's persisted session timestamp
 *     and its running flag settles the tree at the end of a turn, but it
 *     only advances when a step's messages are written — which happens
 *     AFTER the step's tool calls, not when a file is.
 *   - the working tree changing. The status subscription re-reads `git
 *     status` (with per-file line counts) every five seconds and pushes only
 *     when the answer differs, so this is the trigger that catches a write
 *     nothing told the thread about: a terminal command, the user's own
 *     editor, a subagent.
 *   - a plain interval while the agent is working, below, which is what
 *     makes an `edit` mid-step show up while it still means something.
 *
 * The refresh function is read through a ref rather than listed as a
 * dependency: `useAtomRefresh` returns a new closure whenever the underlying
 * atom changes, and depending on it would re-run this effect on every
 * refresh it performs.
 */
export function useDiffAutoRefresh({
  refresh,
  threadRevision,
  threadIsRunning,
  workingTreeRevision,
  readsLiveTree,
}: DiffAutoRefreshInput) {
  const refreshSelectedPatch = useRef<() => void>(() => {});
  refreshSelectedPatch.current = refresh;
  const documentVisible = useDocumentVisible();
  // `documentVisible` is a revision like the others: the tree can move while the
  // window is hidden and the poll below is not running, so coming back is a
  // reason to re-read. Debounced with the rest rather than refreshed on the
  // spot, so returning to the app costs one refresh and not two.
  useEffect(() => {
    if (threadRevision === null && workingTreeRevision === null) return;
    const timer = setTimeout(() => refreshSelectedPatch.current(), DIFF_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [documentVisible, threadRevision, threadIsRunning, workingTreeRevision]);
  // Only for a selection that reads the tree as it is now. A turn's checkpoint
  // diff is a pair of commits that already happened — polling it would be a
  // `git diff` every second and a half for an answer that cannot change.
  //
  // Gated on visibility too: the poll exists to keep on-screen state current, so
  // behind a hidden window it is a `git diff` subprocess every second and a half
  // that nobody reads.
  const shouldPollWorkingTree = threadIsRunning && readsLiveTree && documentVisible;
  useEffect(() => {
    if (!shouldPollWorkingTree) return;
    const timer = setInterval(() => refreshSelectedPatch.current(), DIFF_REFRESH_WHILE_RUNNING_MS);
    return () => clearInterval(timer);
  }, [shouldPollWorkingTree]);
  return refreshSelectedPatch;
}
