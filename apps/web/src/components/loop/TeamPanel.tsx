/**
 * The team panel: the thread team this chat is in, in one place — docked in
 * the right panel like the checklist, from the lead or from any thread.
 *
 * Every thread with its state, what it is doing and what it has cost; the
 * team's shared board; the whole team's spend (the user's own messages in a
 * thread included); and Stop. Opening a thread from here opens the panel
 * there too, so hopping between threads keeps the team in view.
 */
import type { ScopedThreadRef, TeamMember, TeamSnapshot } from "@loop/contracts";
import { NetworkIcon, NotebookPenIcon, SquareIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { teamAtoms } from "../../state/team";
import { Button } from "../ui/button";
import { useThreadTeam } from "./LoopTeam";
import { LaneDot, TeamRail, TintPill } from "./TeamRail";
import { formatTeamUsd, teamLaneFor, teamMemberWorking, type TeamLane } from "./teamPresentation";

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-2 pt-4 pb-1">
        <span className="font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
          {title}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border" />
        {aside}
      </div>
      {children}
    </section>
  );
}

/** What the header says the team is up to, as one tinted chip — or nothing when it is at rest. */
function TeamStatusChip({ team, working }: { team: TeamSnapshot; working: number }) {
  if (working > 0) {
    return (
      <TintPill className="h-5 gap-1 px-1.5 text-[11px] bg-chip-blue text-chip-blue-foreground">
        {working} working
      </TintPill>
    );
  }
  if (team.overBudget) {
    return (
      <TintPill className="h-5 px-1.5 text-[11px] bg-chip-orange text-chip-orange-foreground">
        Stopped at its budget
      </TintPill>
    );
  }
  if (team.stopped) {
    return (
      <TintPill className="h-5 px-1.5 text-[11px] bg-chip-neutral text-chip-neutral-foreground">
        Stopped
      </TintPill>
    );
  }
  return null;
}

/** Each thread's share of the spend as one segmented bar, in the threads' own colours. */
function CostBar({ team, members }: { team: TeamSnapshot; members: readonly TeamMember[] }) {
  const total = members.reduce((sum, member) => sum + member.usd, 0);
  if (total <= 0) return null;
  return (
    <div className="mx-2 mb-1.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
      {members
        .filter((member) => member.usd > 0)
        .map((member) => (
          <span
            className={cn("h-full", teamLaneFor(team, member.id).dotClass)}
            key={member.id}
            style={{ width: `${(member.usd / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

function CostLine({ member, lane }: { member: TeamMember; lane: TeamLane }) {
  const yours = member.usd - member.teamUsd;
  return (
    <div className="flex items-center gap-2 px-2 py-0.5 text-[12px]">
      <LaneDot className="scale-75" lane={lane} />
      <span className="min-w-0 flex-1 truncate text-foreground">{member.title}</span>
      {member.role === "member" && yours > 0.00005 ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          incl. {formatTeamUsd(yours)} yours
        </span>
      ) : null}
      <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
        {formatTeamUsd(member.usd)}
      </span>
    </div>
  );
}

/** A board note's author, by title — the board names threads, it does not id them. */
function laneByTitle(team: TeamSnapshot, title: string): TeamLane {
  const member = [team.lead, ...team.members].find((m) => m.title === title);
  return teamLaneFor(team, member?.id ?? team.lead.id);
}

export const TeamPanel = memo(function TeamPanel({
  threadRef,
}: {
  threadRef: ScopedThreadRef | null;
}) {
  const team: TeamSnapshot | null = useThreadTeam(threadRef);
  const stop = useAtomCommand(teamAtoms.stop, "Stop the team");

  const keepPanelOn = useCallback(
    (member: TeamMember) => {
      if (!threadRef) return;
      useRightPanelStore
        .getState()
        .open(
          { environmentId: threadRef.environmentId, threadId: member.threadId as never },
          "team",
        );
    },
    [threadRef],
  );

  if (!threadRef) return null;
  if (!team) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-xs">
          <span className="mx-auto mb-3 flex size-8 items-center justify-center rounded-full bg-chip-neutral">
            <NetworkIcon aria-hidden className="size-4 text-muted-foreground" />
          </span>
          <p className="font-medium text-foreground text-sm">No thread team here</p>
          <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
            With “thread teams” on in Settings, the agent can split a big job across threads that
            work in parallel. They show up here.
          </p>
        </div>
      </div>
    );
  }

  const working = team.members.filter(teamMemberWorking).length;
  const all = [team.lead, ...team.members];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
      <div className="flex items-center gap-2.5 px-2 pt-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-chip-blue">
          <NetworkIcon aria-hidden className="size-4 text-chip-blue-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-[13px] text-foreground">{team.lead.title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span className="shrink-0">
              {team.members.length} thread{team.members.length === 1 ? "" : "s"}
            </span>
            {team.cost.usd > 0 ? (
              <span className="shrink-0 tabular-nums">
                · {formatTeamUsd(team.cost.usd)}
                {team.cost.estimated ? (
                  <span title="Includes an estimate for an interrupted step"> ~</span>
                ) : null}
              </span>
            ) : null}
            <TeamStatusChip team={team} working={working} />
          </div>
        </div>
        {working > 0 && !team.stopped ? (
          <Button
            onClick={() =>
              void stop({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId },
              })
            }
            size="xs"
            variant="outline"
          >
            <SquareIcon aria-hidden className="size-3" />
            Stop
          </Button>
        ) : null}
      </div>

      <Section title="Threads">
        <TeamRail
          currentThreadId={threadRef.threadId}
          environmentId={threadRef.environmentId}
          onOpen={keepPanelOn}
          team={team}
        />
      </Section>

      {team.board.length > 0 ? (
        <Section
          title="Board"
          aside={<NotebookPenIcon aria-hidden className="size-3 text-muted-foreground" />}
        >
          <div className="flex flex-col gap-1.5 px-1">
            {team.board.map((note) => (
              <div className="rounded-lg bg-card px-2.5 py-2" key={note.key}>
                <div className="flex min-w-0 items-center gap-2">
                  <TintPill className="h-5 px-1.5 font-mono text-[11px] bg-chip-neutral text-foreground">
                    {note.key}
                  </TintPill>
                  <span className="min-w-0 flex-1" />
                  {note.fromTitle ? (
                    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <LaneDot className="scale-75" lane={laneByTitle(team, note.fromTitle)} />
                      <span className="truncate">{note.fromTitle}</span>
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap text-[12px] text-foreground/90 leading-[1.55]">
                  {note.body}
                </p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {team.cost.usd > 0 ? (
        <Section title="Cost">
          <CostBar members={all} team={team} />
          {all.map((member) => (
            <CostLine key={member.id} lane={teamLaneFor(team, member.id)} member={member} />
          ))}
          <div className="mx-2 mt-1 flex items-baseline gap-2 border-border border-t pt-1.5 text-[12.5px]">
            <span className="flex-1 font-medium text-foreground">Team total</span>
            <span className="font-medium text-foreground tabular-nums">
              {formatTeamUsd(team.cost.usd)}
            </span>
          </div>
        </Section>
      ) : null}
    </div>
  );
});
