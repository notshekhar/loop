/**
 * A thread's team (packages/core/src/teams), live: `subscribeTeam` and
 * `team.stop`.
 *
 * Pushed, never polled. The host announces every move a team makes as a
 * host-wide `session.status` notice with `change: "team"` (a thread joined or
 * moved state, what one is doing, what it spent, a board note), and a turn
 * starting or ending as `change: "running"`. Each notice that could touch this
 * team triggers one `team.get`, coalesced, so a busy team of five costs the
 * phone a read every few hundred milliseconds at most.
 */
import type { TeamMember, TeamSnapshot, TeamStreamEvent } from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { defaultLoopHost, type LoopHost } from "../transport.ts";
import { clientThreadIdFor, loopSessionIdFor } from "./dispatch.ts";
import { pinSession, refreshSessionWindow } from "./sessionPaging.ts";
import type { EnvironmentAuthorizationError } from "@loop/contracts";

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function memberOf(raw: unknown): TeamMember | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    threadId: clientThreadIdFor(raw.id),
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Thread",
    role: raw.role === "lead" ? "lead" : "member",
    state: typeof raw.state === "string" ? raw.state : "idle",
    ...(typeof raw.activity === "string" && raw.activity ? { activity: raw.activity } : {}),
    running: raw.running === true,
    usd: num(raw.usd),
    teamUsd: num(raw.teamUsd),
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
  };
}

/** loop's `team.get` answer, narrowed — null for "not in a team" and for anything unusable. */
export function teamSnapshotOf(raw: unknown): TeamSnapshot | null {
  if (!isRecord(raw) || typeof raw.teamId !== "string") return null;
  const lead = memberOf(raw.lead);
  if (!lead) return null;
  const cost = isRecord(raw.cost) ? raw.cost : {};
  return {
    teamId: raw.teamId,
    stopped: raw.stopped === true,
    lead,
    members: (Array.isArray(raw.members) ? raw.members : [])
      .map(memberOf)
      .filter((m): m is TeamMember => m !== null),
    board: (Array.isArray(raw.board) ? raw.board : []).filter(isRecord).map((note) => ({
      key: String(note.key ?? ""),
      body: String(note.body ?? ""),
      fromTitle: isRecord(note.from) && typeof note.from.title === "string" ? note.from.title : "",
      ts: num(note.ts),
    })),
    cost: {
      usd: num(cost.usd),
      inputTokens: num(cost.inputTokens),
      outputTokens: num(cost.outputTokens),
      estimated: cost.estimated === true,
    },
  };
}

/** How long to gather notices before reading the team again. */
const COALESCE_MS = 250;

export function teamStream(
  threadId: string,
  host: LoopHost = defaultLoopHost,
): Stream.Stream<TeamStreamEvent, EnvironmentAuthorizationError> {
  return Stream.callback<TeamStreamEvent, EnvironmentAuthorizationError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let stopped = false;
        let teamId: string | null = null;
        let members = new Set<string>();
        let timer: ReturnType<typeof setTimeout> | null = null;
        let reading = false;
        let again = false;
        let last = "";
        // The sidebar follows the team from here too: every thread is kept in
        // the listed window (pinned) and the list is rebuilt whenever a thread
        // starts, stops or joins — so a lead's threads appear the moment they
        // are spawned, not on the next unrelated refresh.
        const unpins = new Map<string, () => void>();
        let lastLiveness = "";

        const read = async () => {
          if (stopped) return;
          reading = true;
          try {
            const raw = await host.call<unknown>("team.get", {
              sessionId: loopSessionIdFor(threadId),
            });
            const snapshot = teamSnapshotOf(raw);
            teamId = snapshot?.teamId ?? null;
            members = new Set(
              snapshot ? [snapshot.lead.id, ...snapshot.members.map((m) => m.id)] : [],
            );
            if (snapshot && !stopped) {
              for (const m of [snapshot.lead, ...snapshot.members]) {
                if (!unpins.has(m.id)) unpins.set(m.id, pinSession(host.id, m.id));
              }
              const liveness = [snapshot.lead, ...snapshot.members]
                .map((m) => `${m.id}:${m.running ? 1 : 0}:${m.state}`)
                .join(",");
              if (lastLiveness !== "" && liveness !== lastLiveness) refreshSessionWindow(host.id);
              lastLiveness = liveness;
            }
            const encoded = JSON.stringify(snapshot);
            if (encoded !== last && !stopped) {
              last = encoded;
              Queue.offerUnsafe(queue, snapshot);
            }
          } catch {
            // An older loop (no team.get) or a draft with no session yet: no team.
            if (last !== "null" && !stopped) {
              last = "null";
              Queue.offerUnsafe(queue, null);
            }
          } finally {
            reading = false;
            if (again) {
              again = false;
              schedule();
            }
          }
        };

        const schedule = () => {
          if (stopped) return;
          if (reading) {
            again = true;
            return;
          }
          if (timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            void read();
          }, COALESCE_MS);
        };

        const off = host.onEvent((event) => {
          const part = event.part as { type?: string; data?: unknown } | undefined;
          // Not in a team yet: this chat's own turn finishing a tool call may be
          // the spawn that starts one. A belt to the notices' braces — a host
          // that drops host-wide notices still shows its team.
          if (
            teamId === null &&
            part?.type === "tool-result" &&
            event.sessionId === loopSessionIdFor(threadId)
          ) {
            schedule();
            return;
          }
          if (part?.type !== "session-status" || !isRecord(part.data)) return;
          const notice = part.data;
          if (notice.change === "team") {
            // Not in a team yet: any team news may be this thread's first.
            if (teamId === null || notice.teamId === teamId) schedule();
          } else if (notice.change === "running" || notice.change === "renamed") {
            if (members.has(String(notice.sessionId ?? ""))) schedule();
          }
        });

        void read();
        return () => {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          off();
          for (const unpin of unpins.values()) unpin();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );
}

export function stopTeam(input: { readonly threadId: string }, host: LoopHost = defaultLoopHost) {
  return Effect.promise(() =>
    host
      .call<unknown>("team.stop", { sessionId: loopSessionIdFor(input.threadId) })
      .then(() => ({ ok: true }))
      .catch(() => ({ ok: false })),
  );
}

const TEAM_SETTING_KEY = "threadTeams";

async function readTeamSetting(host: LoopHost): Promise<{ enabled: boolean; supported: boolean }> {
  const rows = await host.call<unknown>("settings.list").catch(() => null);
  const row = Array.isArray(rows)
    ? (rows as Array<{ key?: unknown; value?: unknown }>).find((r) => r?.key === TEAM_SETTING_KEY)
    : undefined;
  return row
    ? { enabled: row.value === true, supported: true }
    : { enabled: false, supported: false };
}

/** `team.setting.get`: the host's threadTeams switch (off by default). */
export function getTeamSetting(host: LoopHost = defaultLoopHost) {
  return Effect.promise(() => readTeamSetting(host));
}

/** `team.setting.set`: flip it, and read back what the host now says. */
export function setTeamSetting(
  input: { readonly enabled: boolean },
  host: LoopHost = defaultLoopHost,
) {
  return Effect.promise(async () => {
    await host
      .call("settings.set", { key: TEAM_SETTING_KEY, value: input.enabled })
      .catch(() => undefined);
    return readTeamSetting(host);
  });
}
