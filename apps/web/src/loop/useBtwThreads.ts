/**
 * The `/btw` side threads asked from a thread, live (handlers/btw.ts) — shared
 * by the desktop's chat view and the phone's thread screen.
 */
import { useEffect, useState } from "react";

import { btwThreadViews, onBtwThreadsChange, type BtwThreadView } from "./handlers/btw.ts";
import { loopSessionIdFor } from "./handlers/dispatch.ts";
import { onLiveTurnChange } from "./handlers/liveTurn.ts";

/** Views equal in what is drawn — a stream delta elsewhere must not re-render this. */
function sameViews(a: readonly BtwThreadView[], b: readonly BtwThreadView[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (view, i) =>
        view.thread === b[i]!.thread &&
        view.answer === b[i]!.answer &&
        view.running === b[i]!.running &&
        view.error === b[i]!.error,
    )
  );
}

export function useBtwThreads(threadId: string): readonly BtwThreadView[] {
  const sourceSessionId = loopSessionIdFor(threadId);
  const [views, setViews] = useState(() => btwThreadViews(sourceSessionId));
  useEffect(() => {
    const refresh = () =>
      setViews((current) => {
        const next = btwThreadViews(sourceSessionId);
        return sameViews(current, next) ? current : next;
      });
    refresh();
    const offThreads = onBtwThreadsChange(refresh);
    const offTurns = onLiveTurnChange(refresh);
    return () => {
      offThreads();
      offTurns();
    };
  }, [sourceSessionId]);
  return views;
}

export {
  btwStatusOf,
  dismissBtwThread,
  isBtwPrompt,
  type BtwStatus,
  type BtwThreadView,
} from "./handlers/btw.ts";
export { clientThreadIdFor } from "./handlers/dispatch.ts";
