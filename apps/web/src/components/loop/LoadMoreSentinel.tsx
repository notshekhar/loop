import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

/**
 * The end of an infinitely scrolled list: when it comes within `margin` of
 * being seen, `onVisible` runs — show the next page already loaded, or fetch
 * the next one (useSessionPaging). It fires again each time it re-enters, so
 * a list still short of the screen after a page keeps filling.
 */
export function LoadMoreSentinel({
  onVisible,
  loading,
  itemCount,
  className,
  margin = 240,
}: {
  onVisible: () => void;
  loading: boolean;
  /** How many rows the list shows now; a change re-arms the observer. */
  itemCount: number;
  className?: string;
  margin?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    // Clipped by the sidebar's own scroll box, so "visible" means visible
    // in the list, not merely inside the window.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { rootMargin: `0px 0px ${margin}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // Re-observed after each page, so one that still leaves it on screen
    // asks for the next instead of waiting for a scroll that cannot come.
  }, [margin, loading, itemCount]);

  return (
    <div
      aria-hidden={!loading}
      className={cn("flex h-8 items-center px-2.5 text-[11px] text-sidebar-muted-foreground/55", className)}
      ref={ref}
    >
      {loading ? "Loading…" : null}
    </div>
  );
}
