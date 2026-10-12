/**
 * How a pull request reads on the phone: its state, checks and review in
 * words and colours, sizes and ages in short form. Pure, so the screens stay
 * layout and these stay tested.
 */
import type {
  LoopPullRequestCheck,
  LoopPullRequestChecksState,
  LoopPullRequestSummary,
} from "@loop/contracts";

export interface Tone {
  readonly label: string;
  readonly textClass: string;
  readonly dotClass: string;
}

/** Open, Draft, Merged or Closed — GitHub's own colours. */
export function stateTone(pr: Pick<LoopPullRequestSummary, "state" | "isDraft">): Tone {
  if (pr.state === "merged") {
    return { label: "Merged", textClass: "text-violet-600 dark:text-violet-300", dotClass: "bg-violet-500" };
  }
  if (pr.state === "closed") {
    return { label: "Closed", textClass: "text-danger", dotClass: "bg-danger" };
  }
  if (pr.isDraft) {
    return { label: "Draft", textClass: "text-foreground-muted", dotClass: "bg-neutral-400" };
  }
  return { label: "Open", textClass: "text-emerald-600 dark:text-emerald-300", dotClass: "bg-emerald-500" };
}

export function checksTone(state: LoopPullRequestChecksState): Tone | null {
  switch (state) {
    case "passing":
      return { label: "Checks passing", textClass: "text-emerald-600 dark:text-emerald-300", dotClass: "bg-emerald-500" };
    case "failing":
      return { label: "Checks failing", textClass: "text-danger", dotClass: "bg-danger" };
    case "pending":
      return { label: "Checks running", textClass: "text-amber-600 dark:text-amber-300", dotClass: "bg-amber-500" };
    default:
      return null;
  }
}

export function checkTone(check: Pick<LoopPullRequestCheck, "status">): Tone {
  switch (check.status) {
    case "success":
      return { label: "Passed", textClass: "text-emerald-600 dark:text-emerald-300", dotClass: "bg-emerald-500" };
    case "failure":
    case "cancelled":
      return {
        label: check.status === "cancelled" ? "Cancelled" : "Failed",
        textClass: "text-danger",
        dotClass: "bg-danger",
      };
    case "pending":
      return { label: "Running", textClass: "text-amber-600 dark:text-amber-300", dotClass: "bg-amber-500" };
    default:
      return {
        label: check.status === "skipped" ? "Skipped" : "Neutral",
        textClass: "text-foreground-muted",
        dotClass: "bg-neutral-400",
      };
  }
}

export function reviewLabel(decision: LoopPullRequestSummary["reviewDecision"]): string | null {
  switch (decision) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "review_required":
      return "Review required";
    default:
      return null;
  }
}

/** A reviewer's latest state, in words. */
export function reviewerStateLabel(state: string): string {
  switch (state) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Requested changes";
    case "requested":
      return "Awaiting review";
    case "dismissed":
      return "Dismissed";
    default:
      return "Commented";
  }
}

/** "3m", "5h", "2d", "4w", else a date — the list's age column. */
export function shortAge(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "+1.2k −40" — thousands shortened, the minus a real minus sign. */
export function formatChangeSize(additions: number, deletions: number): string {
  const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  return `+${short(additions)} −${short(deletions)}`;
}

/** The file name and the folder it sits in, for a two-line file row. */
export function splitPath(path: string): { readonly name: string; readonly folder: string } {
  const at = path.lastIndexOf("/");
  return at === -1 ? { name: path, folder: "" } : { name: path.slice(at + 1), folder: path.slice(0, at) };
}
