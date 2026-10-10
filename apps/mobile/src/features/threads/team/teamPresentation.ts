/**
 * How a thread team member's state reads on the phone — the same words and
 * colours as the desktop's team panel (apps/web components/loop/
 * teamPresentation.ts), in NativeWind classes.
 */
export interface MobileTeamState {
  readonly label: string;
  readonly dotClass: string;
  readonly textClass: string;
}

export function mobileTeamState(state: string, running = false): MobileTeamState {
  if (running || state === "running" || state === "starting") {
    return {
      label: state === "starting" && !running ? "Starting" : "Working",
      dotClass: "bg-sky-500",
      textClass: "text-sky-600 dark:text-sky-300",
    };
  }
  switch (state) {
    case "waiting":
      return {
        label: "Waiting",
        dotClass: "bg-amber-500",
        textClass: "text-amber-600 dark:text-amber-300",
      };
    case "done":
      return {
        label: "Done",
        dotClass: "bg-emerald-500",
        textClass: "text-emerald-600 dark:text-emerald-300",
      };
    case "failed":
      return { label: "Failed", dotClass: "bg-danger", textClass: "text-danger" };
    case "stopped":
      return { label: "Stopped", dotClass: "bg-neutral-400", textClass: "text-foreground-muted" };
    default:
      return {
        label: "Idle",
        dotClass: "bg-neutral-300 dark:bg-neutral-600",
        textClass: "text-foreground-muted",
      };
  }
}

export function formatTeamUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd >= 0.1 ? 2 : 3)}`;
}

export function isTeamMemberWorking(member: {
  readonly state: string;
  readonly running: boolean;
}): boolean {
  return member.running || member.state === "running" || member.state === "starting";
}

/** The brief a member starts from, minus loop's own framing line. */
export function briefText(text: string | undefined): string {
  return (text ?? "")
    .replace(
      /\n\n\(Brief from "[^"]*"\. Your thread is "[^"]*"\. Call report when you are done\.\)$/,
      "",
    )
    .trim();
}
