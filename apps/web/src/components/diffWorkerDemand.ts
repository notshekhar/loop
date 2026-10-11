/**
 * Whether anything on screen renders a diff, and so needs the diff workers.
 *
 * The pool used to start with every chat — five highlighter workers, each its
 * own V8 instance and thread, alive from the first frame on the home screen
 * whether or not a diff was ever opened, and growing by a syntax grammar per
 * language once one was. Now the first diff, code view or file preview to
 * mount asks for it (`useDiffWorkers`), and DiffWorkerPoolProvider shuts the
 * pool down a couple of minutes after the last one goes away.
 *
 * Its own module, free of the worker bundle, so a component can ask without
 * importing the workers (and tests that render one need no Worker global).
 */
import { createContext, useContext, useEffect, useState } from "react";

let diffDemand = 0;
const demandListeners = new Set<() => void>();
const IDLE_SHUTDOWN_MS = 2 * 60_000;

function setDemand(delta: number): void {
  diffDemand += delta;
  for (const listener of demandListeners) listener();
}

/**
 * Whether the pool is in context: null outside a DiffWorkerPoolProvider (a
 * test, a surface without one), where a diff should render straight away.
 */
export const DiffPoolReadyContext = createContext<boolean | null>(null);

/**
 * Call from any component that renders `@pierre/diffs` output, and render the
 * diff only once this returns true.
 *
 * A diff instance binds the pool it finds when it MOUNTS, so one mounted the
 * frame before the pool exists would highlight on the main thread for its
 * whole life. Waiting the one frame it takes to start the pool avoids that.
 */
export function useDiffWorkers(enabled = true): boolean {
  const ready = useContext(DiffPoolReadyContext);
  useEffect(() => {
    if (!enabled) return;
    setDemand(1);
    return () => setDemand(-1);
  }, [enabled]);
  return ready !== false;
}

/** For the provider: true while anything wants the pool, and for a while after. */
export function useDiffDemand(): boolean {
  const [wanted, setWanted] = useState(diffDemand > 0);
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (diffDemand > 0) {
        if (idle !== undefined) clearTimeout(idle);
        idle = undefined;
        setWanted(true);
      } else if (idle === undefined) {
        idle = setTimeout(() => {
          idle = undefined;
          setWanted(false);
        }, IDLE_SHUTDOWN_MS);
      }
    };
    demandListeners.add(update);
    update();
    return () => {
      demandListeners.delete(update);
      if (idle !== undefined) clearTimeout(idle);
    };
  }, []);
  return wanted;
}
