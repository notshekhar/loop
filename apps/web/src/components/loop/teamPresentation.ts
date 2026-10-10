/**
 * How a thread team member's state reads, everywhere the desktop draws one:
 * the team panel, the spawn card in the lead's chat, the nested sidebar rows.
 *
 * The colours are the sidebar status dots' own (Sidebar.logic.ts), so a thread
 * working inside a team is the same sky blue as any thread working on its own.
 */

export interface TeamStatePresentation {
  readonly label: string;
  readonly dotClass: string;
  readonly textClass: string;
  readonly pulse: boolean;
}

const WORKING = {
  dotClass: "bg-sky-500 dark:bg-sky-300/80",
  textClass: "text-sky-600 dark:text-sky-300/80",
};

export function teamStatePresentation(state: string, running = false): TeamStatePresentation {
  if (running || state === "running") return { label: "Working", ...WORKING, pulse: true };
  switch (state) {
    case "starting":
      return { label: "Starting", ...WORKING, pulse: true };
    case "waiting":
      return {
        label: "Waiting",
        dotClass: "bg-amber-500 dark:bg-amber-300/90",
        textClass: "text-amber-600 dark:text-amber-300/90",
        pulse: false,
      };
    case "done":
      return {
        label: "Done",
        dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
        textClass: "text-emerald-600 dark:text-emerald-300/90",
        pulse: false,
      };
    case "failed":
      return {
        label: "Failed",
        dotClass: "bg-destructive",
        textClass: "text-destructive",
        pulse: false,
      };
    case "stopped":
      return {
        label: "Stopped",
        dotClass: "bg-muted-foreground/40",
        textClass: "text-muted-foreground/70",
        pulse: false,
      };
    default:
      return {
        label: "Idle",
        dotClass: "bg-muted-foreground/30",
        textClass: "text-muted-foreground/70",
        pulse: false,
      };
  }
}

/** `$0.041` under a dollar, `$1.24` above — the precision a team's spend needs. */
export function formatTeamUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd >= 0.1 ? 2 : 3)}`;
}

/** Whether a member is still at work (the counts and the panel's header). */
export function teamMemberWorking(member: {
  readonly state: string;
  readonly running: boolean;
}): boolean {
  return member.running || member.state === "running" || member.state === "starting";
}
