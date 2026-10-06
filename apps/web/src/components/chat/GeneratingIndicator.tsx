/**
 * The "still working" row at the end of a live turn.
 *
 * It used to be three 4px dots at 30% opacity — easy to miss, and identical
 * whether a turn had run for two seconds or two minutes. This is loop's own
 * mark instead: an infinity loop with a comet running its track, a light band
 * sweeping the label, and a rotating verb so a long turn still reads as alive.
 *
 * Everything moves in CSS (`loop-gen-*` in index.css); React only swaps the
 * verb every few seconds. Reduced motion stills all of it.
 */
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Shown in turn when the row has no label of its own (a specific one, such as "Compacting", wins). */
const VERBS = [
  "Working",
  "Looping",
  "Thinking",
  "Cooking",
  "Untangling",
  "Wiring",
  "Noodling",
  "Brewing",
  "Tinkering",
  "Spelunking",
] as const;
const VERB_INTERVAL_MS = 3200;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** The ∞ track with a comet on it. Path length is normalized to 100 so the dash maths stays readable. */
export function LoopMark({ className }: { className?: string }) {
  const path =
    "M12 6 C9.5 2.2 3.5 2.2 3.5 6 C3.5 9.8 9.5 9.8 12 6 C14.5 2.2 20.5 2.2 20.5 6 C20.5 9.8 14.5 9.8 12 6 Z";
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 12"
      className={cn("loop-gen-mark h-3 w-6 shrink-0 overflow-visible", className)}
      fill="none"
    >
      <defs>
        <linearGradient
          id="loop-gen-gradient"
          x1="0"
          y1="0"
          x2="24"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="var(--loop-gen-a)" />
          <stop offset="55%" stopColor="var(--loop-gen-b)" />
          <stop offset="100%" stopColor="var(--loop-gen-c)" />
        </linearGradient>
      </defs>
      <path d={path} pathLength={100} className="loop-gen-track" />
      <path d={path} pathLength={100} className="loop-gen-tail" stroke="url(#loop-gen-gradient)" />
      <path d={path} pathLength={100} className="loop-gen-comet" stroke="url(#loop-gen-gradient)" />
    </svg>
  );
}

function RotatingVerb() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % VERBS.length),
      VERB_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, []);
  // Keyed so each verb mounts fresh and plays the slide-in once.
  return (
    <span key={index} className="loop-gen-verb loop-gen-shimmer inline-block">
      {VERBS[index]}
    </span>
  );
}

export function GeneratingIndicator({
  label,
  elapsed,
}: {
  /** A specific activity ("Compacting"); without one the verb rotates. */
  label?: string | null | undefined;
  /** The live timer, rendered after the verb ("for 12s"). */
  elapsed?: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="off"
      className="flex items-center gap-2.5 pt-1.5 pb-0.5 pl-1 text-xs tabular-nums"
    >
      <LoopMark />
      {/* Each text run owns its shimmer: a light band clipped to glyphs only
          paints on the element that declares it, and the verb's slide-in
          transform would otherwise drop it out of a parent's. */}
      <span className="font-medium">
        {label ? <span className="loop-gen-shimmer">{label}</span> : <RotatingVerb />}
        <span className="loop-gen-shimmer">{elapsed ? <> for {elapsed}</> : "…"}</span>
      </span>
    </div>
  );
}
