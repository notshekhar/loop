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
  /** The state as a tinted pill: its hue on a dark wash of the same hue. */
  readonly chipClass: string;
  readonly pulse: boolean;
}

const WORKING = {
  dotClass: "bg-sky-500 dark:bg-sky-300/80",
  textClass: "text-sky-600 dark:text-sky-300/80",
  chipClass: "bg-chip-blue text-chip-blue-foreground",
};

const QUIET_CHIP = "bg-chip-neutral text-chip-neutral-foreground";

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
        chipClass: "bg-chip-orange text-chip-orange-foreground",
        pulse: false,
      };
    case "done":
      return {
        label: "Done",
        dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
        textClass: "text-emerald-600 dark:text-emerald-300/90",
        chipClass: "bg-chip-green text-chip-green-foreground",
        pulse: false,
      };
    case "failed":
      return {
        label: "Failed",
        dotClass: "bg-destructive",
        textClass: "text-destructive",
        chipClass: "bg-chip-red text-chip-red-foreground",
        pulse: false,
      };
    case "stopped":
      return {
        label: "Stopped",
        dotClass: "bg-muted-foreground/40",
        textClass: "text-muted-foreground/70",
        chipClass: QUIET_CHIP,
        pulse: false,
      };
    default:
      return {
        label: "Idle",
        dotClass: "bg-muted-foreground/30",
        textClass: "text-muted-foreground/70",
        chipClass: QUIET_CHIP,
        pulse: false,
      };
  }
}

/**
 * A thread's own colour — the git-graph idea: each thread wears one hue on its
 * dot, its name pill and its share of the cost bar. The rail's LINES are not
 * coloured per thread (TeamRail.tsx): a hue change at every elbow read as
 * noise, so trunk and branches are one quiet tone. Spelled out in full so
 * Tailwind sees every class.
 */
export interface TeamLane {
  /** The filled dot, and the thread's segment of the cost bar. */
  readonly dotClass: string;
  /** The wash the dot sits in. */
  readonly haloClass: string;
  /** The name as a tinted pill. */
  readonly pillClass: string;
}

export const LEAD_LANE: TeamLane = {
  dotClass: "bg-primary",
  haloClass: "bg-chip-blue",
  pillClass: "bg-chip-blue text-chip-blue-foreground",
};

const MEMBER_LANES: readonly TeamLane[] = [
  {
    dotClass: "bg-violet-500 dark:bg-violet-400",
    haloClass: "bg-violet-500/15 dark:bg-violet-400/15",
    pillClass: "bg-violet-500/10 text-violet-700 dark:bg-violet-400/12 dark:text-violet-300",
  },
  {
    dotClass: "bg-orange-500 dark:bg-orange-400",
    haloClass: "bg-orange-500/15 dark:bg-orange-400/15",
    pillClass: "bg-orange-500/10 text-orange-700 dark:bg-orange-400/12 dark:text-orange-300",
  },
  {
    dotClass: "bg-teal-500 dark:bg-teal-400",
    haloClass: "bg-teal-500/15 dark:bg-teal-400/15",
    pillClass: "bg-teal-500/10 text-teal-700 dark:bg-teal-400/12 dark:text-teal-300",
  },
  {
    dotClass: "bg-pink-500 dark:bg-pink-400",
    haloClass: "bg-pink-500/15 dark:bg-pink-400/15",
    pillClass: "bg-pink-500/10 text-pink-700 dark:bg-pink-400/12 dark:text-pink-300",
  },
  {
    dotClass: "bg-lime-500 dark:bg-lime-400",
    haloClass: "bg-lime-500/15 dark:bg-lime-400/15",
    pillClass: "bg-lime-500/10 text-lime-700 dark:bg-lime-400/12 dark:text-lime-300",
  },
  {
    dotClass: "bg-cyan-500 dark:bg-cyan-400",
    haloClass: "bg-cyan-500/15 dark:bg-cyan-400/15",
    pillClass: "bg-cyan-500/10 text-cyan-700 dark:bg-cyan-400/12 dark:text-cyan-300",
  },
];

/**
 * The lane of the thread with session id `memberId`: blue for the lead, else
 * by its place in the team (spawn order, which never reshuffles), wrapping
 * past six. A thread the team does not list (yet) reads as the lead's blue.
 */
export function teamLaneFor(
  team: {
    readonly lead: { readonly id: string };
    readonly members: readonly { readonly id: string }[];
  } | null,
  memberId: string,
): TeamLane {
  if (!team || team.lead.id === memberId) return LEAD_LANE;
  const index = team.members.findIndex((member) => member.id === memberId);
  return index < 0 ? LEAD_LANE : MEMBER_LANES[index % MEMBER_LANES.length]!;
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

/**
 * The thread ids a spawn_threads call started, read from its result
 * ("- \"Title\" — id 01…" lines) — up to the "Also in your team" list,
 * which names the threads that were already there.
 */
export function startedThreadIds(output: string | undefined | null): string[] {
  if (!output) return [];
  const own = output.split(/\n\s*\nAlso in your team/)[0] ?? "";
  return [...own.matchAll(/— id (\S+)/g)].map((match) => match[1]!);
}

/**
 * Split a team for one spawn card: the threads this call started, then
 * everyone else (earlier spawns and later ones). Falls back to matching the
 * asked-for titles while the result has not arrived.
 */
export function splitSpawnedMembers<T extends { readonly id: string; readonly title: string }>(
  members: readonly T[],
  output: string | undefined | null,
  askedTitles: readonly string[],
): { started: T[]; others: T[] } {
  const ids = startedThreadIds(output);
  const mine =
    ids.length > 0
      ? (member: T) => ids.includes(member.id)
      : (member: T) => askedTitles.includes(member.title);
  const started = members.filter(mine);
  if (started.length === 0) return { started: [], others: [...members] };
  return { started, others: members.filter((member) => !mine(member)) };
}
