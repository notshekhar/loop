import { useEffect, useState } from "react";
import type { GitStatus } from "../../loop/transport";

/**
 * Source control, toggled on inside this panel rather than living in a tab
 * of its own: it describes the very patch on screen, and the comment
 * affordances, scope and scroll all belong to this panel.
 */
export function useScmStatusOverride(polledStatus: unknown) {
  const [scmOverride, setScmOverride] = useState<GitStatus | null>(null);
  useEffect(() => {
    // A fresh poll supersedes a write's answer; it is the one that sees the
    // outside world.
    setScmOverride(null);
  }, [polledStatus]);
  const scmStatus = scmOverride ?? (polledStatus as GitStatus | null);
  return { scmStatus, setScmOverride };
}
