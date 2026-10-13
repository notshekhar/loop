/**
 * How a pull request reads on the desktop: its state, checks and review in
 * words and colours, sizes and ages in short form, the list's search, and the
 * mapping between a diff selection and a GitHub line comment. Pure, so the
 * page stays layout and these stay tested.
 */
import type {
  LoopPullRequestCheck,
  LoopPullRequestChecksState,
  LoopPullRequestSummary,
  LoopPullRequestTimelineItem,
} from "@loop/contracts";

export interface Tone {
  readonly label: string;
  readonly textClass: string;
  readonly dotClass: string;
}

const GREEN = { textClass: "text-success-foreground", dotClass: "bg-success" };
const RED = { textClass: "text-destructive-foreground", dotClass: "bg-destructive" };
const AMBER = { textClass: "text-warning-foreground", dotClass: "bg-warning" };
const MUTED = { textClass: "text-muted-foreground", dotClass: "bg-muted-foreground/50" };
const VIOLET = { textClass: "text-violet-600 dark:text-violet-300", dotClass: "bg-violet-500" };

/** Open, Draft, Merged or Closed — GitHub's own colours. */
export function stateTone(pr: Pick<LoopPullRequestSummary, "state" | "isDraft">): Tone {
  if (pr.state === "merged") return { label: "Merged", ...VIOLET };
  if (pr.state === "closed") return { label: "Closed", ...RED };
  if (pr.isDraft) return { label: "Draft", ...MUTED };
  return { label: "Open", ...GREEN };
}

export function checksTone(state: LoopPullRequestChecksState): Tone | null {
  switch (state) {
    case "passing":
      return { label: "Checks passing", ...GREEN };
    case "failing":
      return { label: "Checks failing", ...RED };
    case "pending":
      return { label: "Checks running", ...AMBER };
    default:
      return null;
  }
}

export function checkTone(check: Pick<LoopPullRequestCheck, "status">): Tone {
  switch (check.status) {
    case "success":
      return { label: "Passed", ...GREEN };
    case "failure":
      return { label: "Failed", ...RED };
    case "cancelled":
      return { label: "Cancelled", ...RED };
    case "pending":
      return { label: "Running", ...AMBER };
    case "skipped":
      return { label: "Skipped", ...MUTED };
    default:
      return { label: "Neutral", ...MUTED };
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

/** A review or reviewer state, in words and colour. */
export function reviewStateTone(state: string): Tone {
  switch (state) {
    case "approved":
      return { label: "Approved", ...GREEN };
    case "changes_requested":
      return { label: "Requested changes", ...RED };
    case "requested":
      return { label: "Awaiting review", ...AMBER };
    case "dismissed":
      return { label: "Dismissed", ...MUTED };
    default:
      return { label: "Commented", ...MUTED };
  }
}

/** "3m", "5h", "2d", "4w", else a date. */
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

/** The file name and the folder it sits in. */
export function splitPath(path: string): { readonly name: string; readonly folder: string } {
  const at = path.lastIndexOf("/");
  return at === -1
    ? { name: path, folder: "" }
    : { name: path.slice(at + 1), folder: path.slice(0, at) };
}

/**
 * The list's search: every word must match the number, title, author, branch
 * or a label. `#12` and `12` both find PR 12.
 */
export function matchesPullRequestQuery(pr: LoopPullRequestSummary, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    `#${pr.number}`,
    pr.title,
    pr.author?.login ?? "",
    pr.headRef,
    ...pr.labels.map((label) => label.name),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) =>
    /^#?\d+$/.test(word) ? String(pr.number).startsWith(word.replace("#", "")) : haystack.includes(word),
  );
}

/** A diff selection's side, as GitHub names it. */
export type DiffSide = "additions" | "deletions";

export function githubSide(side: DiffSide | undefined): "LEFT" | "RIGHT" {
  return side === "deletions" ? "LEFT" : "RIGHT";
}

/** A selected range of lines → the line (and first line) a GitHub comment anchors to. */
export function lineCommentAnchor(range: {
  readonly start: number;
  readonly end: number;
  readonly side?: DiffSide | undefined;
  readonly endSide?: DiffSide | undefined;
}): { line: number; startLine?: number; side: "LEFT" | "RIGHT" } {
  const side = githubSide(range.endSide ?? range.side);
  const line = Math.max(range.start, range.end);
  const first = Math.min(range.start, range.end);
  return first < line ? { line, startLine: first, side } : { line, side };
}

type ThreadItem = Extract<LoopPullRequestTimelineItem, { kind: "thread" }>;

/**
 * Line threads of one file, keyed the way the diff view anchors annotations.
 * Outdated threads (their line is gone) only show in the conversation.
 */
export function threadsByLine(
  timeline: ReadonlyArray<LoopPullRequestTimelineItem>,
  path: string,
): Array<{ side: DiffSide; lineNumber: number; threads: ThreadItem[] }> {
  const groups = new Map<string, { side: DiffSide; lineNumber: number; threads: ThreadItem[] }>();
  for (const item of timeline) {
    if (item.kind !== "thread" || item.path !== path || item.line === null) continue;
    const side: DiffSide = item.side === "LEFT" ? "deletions" : "additions";
    const key = `${side}:${item.line}`;
    const group = groups.get(key) ?? { side, lineNumber: item.line, threads: [] };
    group.threads.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The prompt for "Review with loop": read-only, and nothing posted to GitHub. */
export function reviewPrompt(pr: Pick<LoopPullRequestSummary, "number" | "title" | "url">): string {
  return [
    `Review pull request #${pr.number} ("${pr.title}") — ${pr.url}`,
    "",
    `Read it with \`gh pr view ${pr.number}\` and \`gh pr diff ${pr.number}\`, and look at the surrounding code where you need to.`,
    "Point out bugs, risky changes, missing tests and anything unclear, file by file, most serious first.",
    "Don't change any files and don't post anything to GitHub — just report back here.",
  ].join("\n");
}

/** gh's "not logged in" errors, which the page answers with a sign-in button. */
export function isGithubAuthError(message: string | null): boolean {
  if (!message) return false;
  return /gh auth login|not logged in|authentication|HTTP 401|bad credentials|token .*invalid/i.test(
    message,
  );
}

/** gh missing altogether, which no sign-in fixes. */
export function isGhMissingError(message: string | null): boolean {
  return message !== null && /not installed or not on PATH/i.test(message);
}
