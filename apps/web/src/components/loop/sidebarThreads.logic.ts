/**
 * What a thread is DOING, for the sidebars that sort by it.
 *
 * The `projects` and `focused` sidebars both answer the same question before
 * they draw anything — is this thread waiting on me, working, merely recent, or
 * settled — so the answer lives here once. The `threads` sidebar (upstream's)
 * has its own richer machinery and does not come through this file.
 *
 * Nothing here is new information. Every field was already on the thread shell
 * and already used by the command palette's status dot; the sidebars simply
 * never read it, which is why a thread blocked on an approval used to look
 * exactly like an idle one.
 *
 * Kept out of the components so the ordering rules can be tested without a
 * router, an atom registry or a clock.
 */
import type { EnvironmentId, ProjectId, ThreadId } from "@loop/contracts";
import type { EnvironmentThreadShell } from "@loop/runtime/state/models";
import { effectiveSettled } from "@loop/runtime/state/thread-settled";

import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";

/**
 * Which section a thread belongs in.
 *
 * Ordered by how much of your attention the thread is asking for, which is
 * also the order the sections render in.
 */
export type SidebarThreadState = "needs-you" | "working" | "recent" | "settled";

export interface SidebarThreadRow {
  // Branded, like the project row's ids: a row hands these straight back to
  // `scopeThreadRef` to act on the thread, so widening them to `string` would
  // only move the cast into every menu handler.
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly updatedAt: string;
  readonly state: SidebarThreadState;
  /** The dot and label, or null for a thread with nothing to report. */
  readonly status: ThreadStatusPill | null;
  /** How long it has been asking, for the "needs you" ordering. */
  readonly waitingSince: number;
  /** Its place in a thread team (packages/core/src/teams), or null. */
  readonly team: { readonly role: "lead" | "member"; readonly state: string } | null;
  /**
   * A lead's threads, drawn nested under it rather than scattered through the
   * list by recency. Empty for every other row — including a thread whose
   * lead is not in this list (it then stands alone and says whose it is).
   */
  readonly children: readonly SidebarThreadRow[];
}

export interface SidebarThreadSections {
  readonly needsYou: readonly SidebarThreadRow[];
  readonly working: readonly SidebarThreadRow[];
  readonly recent: readonly SidebarThreadRow[];
  readonly settled: readonly SidebarThreadRow[];
}

export interface SidebarThreadOptions {
  /** ISO now, passed in rather than read, so tests are not clock-dependent. */
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  /** Last-visited stamps by scoped thread key — drives "completed, unseen". */
  readonly lastVisitedAtByKey?: Readonly<Record<string, string>>;
}

/** The key `uiStateStore` files last-visited stamps under. */
export function threadVisitKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

/**
 * Is this thread asking the user a question?
 *
 * Approvals and user input are explicit asks. A finished plan is the third:
 * loop stops and waits for you to accept it, and a plan nobody looks at is the
 * cheapest way to lose an hour.
 */
export function threadNeedsYou(thread: EnvironmentThreadShell, status: ThreadStatusPill | null): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
  return status?.label === "Plan Ready";
}

export function threadIsWorking(thread: EnvironmentThreadShell): boolean {
  return thread.session?.status === "running" || thread.session?.status === "starting";
}

/**
 * One thread, classified.
 *
 * The order of the checks is the whole rule: an ask outranks a live session,
 * because a running thread needs nothing from you and a blocked one needs you
 * now. Settled is asked last, and `effectiveSettled` already refuses to settle
 * anything blocked or running — so a settled row is genuinely finished with.
 */
export function classifySidebarThread(
  thread: EnvironmentThreadShell,
  options: SidebarThreadOptions,
): SidebarThreadRow {
  const lastVisitedAt = options.lastVisitedAtByKey?.[threadVisitKey(thread.environmentId, thread.id)];
  const status = resolveThreadStatusPill({
    thread: { ...thread, ...(lastVisitedAt === undefined ? {} : { lastVisitedAt }) },
  });
  const state: SidebarThreadState = threadNeedsYou(thread, status)
    ? "needs-you"
    : threadIsWorking(thread)
      ? "working"
      : effectiveSettled(thread, {
            now: options.now,
            autoSettleAfterDays: options.autoSettleAfterDays,
          })
        ? "settled"
        : "recent";

  // A thread has been waiting since its last turn ended — that is the moment it
  // stopped and asked. Falling back to updatedAt keeps the ordering total.
  const waitingSinceRaw = thread.latestTurn?.completedAt ?? thread.updatedAt;
  const waitingSince = Date.parse(waitingSinceRaw);

  return {
    id: thread.id,
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    title: thread.title.trim() || "Untitled",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    updatedAt: thread.updatedAt,
    state,
    status,
    waitingSince: Number.isFinite(waitingSince) ? waitingSince : 0,
    team: thread.team ? { role: thread.team.role, state: thread.team.state } : null,
    children: [],
  };
}

const STATE_URGENCY: Record<SidebarThreadState, number> = { "needs-you": 0, working: 1, recent: 2, settled: 3 };

const byRecency = (left: SidebarThreadRow, right: SidebarThreadRow): number =>
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt);

/**
 * Every non-archived thread, split into its sections.
 *
 * Archived threads are dropped outright rather than sorted into a shelf: they
 * are archived, and the Archive settings page is where they live.
 *
 * "Needs you" is ordered oldest-ask FIRST, which is the one list here that does
 * not run newest-first. A question that has been waiting an hour is more urgent
 * than one asked a minute ago, and burying it under the newest ask is how a
 * thread gets forgotten in the first place.
 */
export function buildSidebarThreadSections(
  threads: readonly EnvironmentThreadShell[],
  options: SidebarThreadOptions,
): SidebarThreadSections {
  const needsYou: SidebarThreadRow[] = [];
  const working: SidebarThreadRow[] = [];
  const recent: SidebarThreadRow[] = [];
  const settled: SidebarThreadRow[] = [];

  // Thread teams: a member whose lead is listed here goes under its lead.
  const live = threads.filter((thread) => thread.archivedAt === null);
  const listed = new Set(live.map((thread) => `${thread.environmentId}:${thread.id}`));
  const membersByLead = new Map<string, SidebarThreadRow[]>();
  const nestedKey = (thread: EnvironmentThreadShell): string | null =>
    thread.team?.role === "member" && listed.has(`${thread.environmentId}:${thread.team.leadThreadId}`)
      ? `${thread.environmentId}:${thread.team.leadThreadId}`
      : null;
  for (const thread of live) {
    const leadKey = nestedKey(thread);
    if (leadKey === null) continue;
    const list = membersByLead.get(leadKey) ?? [];
    list.push(classifySidebarThread(thread, options));
    membersByLead.set(leadKey, list);
  }

  for (const thread of live) {
    if (nestedKey(thread) !== null) continue;
    let row = classifySidebarThread(thread, options);
    const children = membersByLead.get(`${thread.environmentId}:${thread.id}`);
    if (children && children.length > 0) {
      // A team is as urgent as its most urgent thread: a member waiting on
      // you surfaces its lead in "Needs you".
      const loudest = children.reduce(
        (worst, child) => (STATE_URGENCY[child.state] < STATE_URGENCY[worst] ? child.state : worst),
        row.state,
      );
      row = {
        ...row,
        state: loudest,
        // Session ids are ULIDs: by id is the order the lead started them in.
        children: children.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      };
    }
    if (row.state === "needs-you") needsYou.push(row);
    else if (row.state === "working") working.push(row);
    else if (row.state === "settled") settled.push(row);
    else recent.push(row);
  }

  return {
    needsYou: needsYou.toSorted((left, right) => left.waitingSince - right.waitingSince),
    working: working.toSorted(byRecency),
    recent: recent.toSorted(byRecency),
    settled: settled.toSorted(byRecency),
  };
}

/**
 * What a collapsed project row says about the threads inside it.
 *
 * A folder is only as calm as its loudest thread, so the rollup carries the
 * most urgent state rather than a total — a count of eleven tells you nothing
 * about whether one of them is stuck waiting for you.
 */
export interface ProjectRollup {
  readonly needsYou: number;
  readonly working: number;
  /** Threads that are neither archived nor settled — the "live" count. */
  readonly openCount: number;
  readonly lastActivity: number;
}

export function rollupForProject(
  sections: SidebarThreadSections,
  projectId: string,
): ProjectRollup {
  let needsYou = 0;
  let working = 0;
  let openCount = 0;
  let lastActivity = 0;
  const bump = (row: SidebarThreadRow): void => {
    const updated = Date.parse(row.updatedAt);
    if (Number.isFinite(updated) && updated > lastActivity) lastActivity = updated;
  };
  for (const row of sections.needsYou) {
    if (row.projectId !== projectId) continue;
    needsYou++;
    openCount++;
    bump(row);
  }
  for (const row of sections.working) {
    if (row.projectId !== projectId) continue;
    working++;
    openCount++;
    bump(row);
  }
  for (const row of sections.recent) {
    if (row.projectId !== projectId) continue;
    openCount++;
    bump(row);
  }
  for (const row of sections.settled) {
    if (row.projectId !== projectId) continue;
    bump(row);
  }
  return { needsYou, working, openCount, lastActivity };
}

/** The rows of one project, in section order, for the sidebars that nest. */
export function sectionsForProject(
  sections: SidebarThreadSections,
  projectId: string,
  /** The project's machine. A project id is a folder, the same on every
   * machine paired, so without this one project shows every machine's threads. */
  environmentId?: string,
): SidebarThreadSections {
  const mine = (rows: readonly SidebarThreadRow[]) =>
    rows.filter(
      (row) =>
        row.projectId === projectId &&
        (environmentId === undefined || row.environmentId === environmentId),
    );
  return {
    needsYou: mine(sections.needsYou),
    working: mine(sections.working),
    recent: mine(sections.recent),
    settled: mine(sections.settled),
  };
}
