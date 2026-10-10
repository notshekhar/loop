/**
 * How much of a host's session list the shell holds — infinite scroll.
 *
 * A host can have thousands of sessions, and the shell used to list every one
 * of them on every rebuild: one `session.list` of the lot, decoded, sorted and
 * handed to a list that rendered a few dozen. Now the shell asks for a WINDOW,
 * the newest `SESSION_PAGE`, and a list that scrolls near its end asks for the
 * next page (`loadMoreSessions`), which widens the window and rebuilds.
 *
 * There are windows per scope: the whole host (the phone's home list) and one
 * per folder a client is looking at (the desktop's project sidebar), so a
 * project whose sessions are all older than the newest page still lists them.
 * Threads someone has OPEN are pinned into the shell whatever the windows say,
 * because a thread's view is merged with its shell row.
 *
 * The UI talks about environments; the handlers talk about hosts. Each
 * `makeHandlers` registers which host an environment is, and everything here
 * is keyed by host.
 */

/** Sessions per page. A screenful twice over on a phone, a sidebar's worth on desktop. */
export const SESSION_PAGE = 40;

/** One scope's window: how many it asks for, and whether there are more. */
export interface SessionWindow {
  readonly limit: number;
  /** False until a page comes back short (or before the first one at all). */
  readonly hasMore: boolean;
  /** A wider window was asked for and its rebuild has not landed yet. */
  readonly loading: boolean;
}

const ALL = "";
const EMPTY: SessionWindow = { limit: SESSION_PAGE, hasMore: false, loading: false };

/** host id → scope ("" = all, else a folder) → window. */
const windows = new Map<string, Map<string, SessionWindow>>();
/** host id → session id → open count. */
const pinned = new Map<string, Map<string, number>>();
/** host id → the latest search's matches. */
const searchPins = new Map<string, readonly string[]>();
/** environment id → host id. */
const hostOfEnvironment = new Map<string, string>();

const changeListeners = new Set<(hostId: string) => void>();
const uiListeners = new Set<() => void>();
let version = 0;

function notifyUi(): void {
  version++;
  for (const l of uiListeners) l();
}

function scopesOf(hostId: string): Map<string, SessionWindow> {
  let m = windows.get(hostId);
  if (!m) windows.set(hostId, (m = new Map([[ALL, EMPTY]])));
  return m;
}

function hostFor(environmentId: string): string {
  return hostOfEnvironment.get(environmentId) ?? environmentId;
}

/** Called by makeHandlers: this environment is served by that host. */
export function registerEnvironmentHost(environmentId: string, hostId: string): void {
  hostOfEnvironment.set(environmentId, hostId);
}

// ── what the shell reads and reports ─────────────────────────────────────

/** Every scope the shell must fetch for `hostId`, with its limit. */
export function sessionScopes(hostId: string): ReadonlyArray<{ readonly cwd: string | null; readonly limit: number }> {
  return [...scopesOf(hostId)].map(([scope, w]) => ({ cwd: scope === ALL ? null : scope, limit: w.limit }));
}

/** Sessions open somewhere in this client, which the shell includes regardless. */
export function pinnedSessionIds(hostId: string): string[] {
  return [...new Set([...(pinned.get(hostId)?.keys() ?? []), ...(searchPins.get(hostId) ?? [])])];
}

/**
 * What the latest search on this host matched: listed by the shell even when
 * older than its windows, so a list filtered to the matches can show them.
 * Replaced by the next search; a rebuild only when it adds something new.
 */
export function setSearchPins(hostId: string, sessionIds: readonly string[]): void {
  const before = new Set(pinnedSessionIds(hostId));
  searchPins.set(hostId, sessionIds);
  if (sessionIds.some((id) => !before.has(id))) changed(hostId);
}

/** A rebuild fetched `received` rows for a scope it asked `limit` of. */
export function reportSessionPage(hostId: string, cwd: string | null, limit: number, received: number): void {
  const scopes = scopesOf(hostId);
  const key = cwd ?? ALL;
  const current = scopes.get(key);
  // A window widened while this rebuild was in flight is not settled by it.
  if (!current || current.limit !== limit) return;
  const next: SessionWindow = { limit, hasMore: received >= limit, loading: false };
  if (next.hasMore === current.hasMore && !current.loading) return;
  scopes.set(key, next);
  notifyUi();
}

/** Shell rebuilds subscribe here: a window widened or a session was pinned. */
export function onSessionWindowChange(listener: (hostId: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function changed(hostId: string): void {
  for (const l of changeListeners) l(hostId);
  notifyUi();
}

/** A thread's view opened: keep its session in the shell while it is open. */
export function pinSession(hostId: string, sessionId: string): () => void {
  let m = pinned.get(hostId);
  if (!m) pinned.set(hostId, (m = new Map()));
  const before = m.get(sessionId) ?? 0;
  m.set(sessionId, before + 1);
  // Already listed or not, a rebuild is only worth it the first time.
  if (before === 0) changed(hostId);
  return () => {
    const n = (m!.get(sessionId) ?? 1) - 1;
    if (n <= 0) m!.delete(sessionId);
    else m!.set(sessionId, n);
  };
}

/**
 * Rebuild the shell for a host now. For news the shell cannot hear on its own
 * — a thread team's threads starting and stopping, which the team panel learns
 * from its own subscription (team.ts).
 */
export function refreshSessionWindow(hostId: string): void {
  changed(hostId);
}

// ── what the UI calls ────────────────────────────────────────────────────

/**
 * The window for an environment's sessions — all of them (`cwd` omitted) or
 * one folder's.
 */
export function sessionWindow(environmentId: string, cwd?: string | null): SessionWindow {
  return scopesOf(hostFor(environmentId)).get(cwd ?? ALL) ?? EMPTY;
}

/**
 * The list scrolled near its end: fetch the next page. A no-op while one is
 * already loading or when the last page came back short.
 */
export function loadMoreSessions(environmentId: string, cwd?: string | null): void {
  const hostId = hostFor(environmentId);
  const scopes = scopesOf(hostId);
  const key = cwd ?? ALL;
  const current = scopes.get(key) ?? EMPTY;
  if (current.loading || !current.hasMore) return;
  scopes.set(key, { limit: current.limit + SESSION_PAGE, hasMore: true, loading: true });
  changed(hostId);
}

/**
 * A view of one folder opened: give it a window of its own (the newest page
 * of THAT folder), so its sessions do not depend on how recent they are
 * across the whole host.
 */
export function watchSessionFolder(environmentId: string, cwd: string): void {
  const hostId = hostFor(environmentId);
  const scopes = scopesOf(hostId);
  if (scopes.has(cwd)) return;
  scopes.set(cwd, { limit: SESSION_PAGE, hasMore: false, loading: true });
  changed(hostId);
}

/** For `useSyncExternalStore`: subscribe, and a snapshot that changes when any window does. */
export function subscribeSessionPaging(listener: () => void): () => void {
  uiListeners.add(listener);
  return () => uiListeners.delete(listener);
}

export function sessionPagingVersion(): number {
  return version;
}

/** Tests only. */
export function resetSessionPagingForTests(): void {
  windows.clear();
  pinned.clear();
  searchPins.clear();
  hostOfEnvironment.clear();
  version = 0;
}
