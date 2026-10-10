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

import { useRightPanelStore } from "../../rightPanelStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { teamAtoms } from "../../state/team";
import { Button } from "../ui/button";
import { TeamMemberRow, useThreadTeam } from "./LoopTeam";
import { formatTeamUsd, teamMemberWorking } from "./teamPresentation";

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
      <div className="flex items-center gap-2 px-2 pt-3 pb-1">
        <span className="font-medium text-[10.5px] text-muted-foreground/60 uppercase tracking-[0.04em]">
          {title}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border/60" />
        {aside}
      </div>
      {children}
    </section>
  );
}

function CostLine({ member }: { member: TeamMember }) {
  const yours = member.usd - member.teamUsd;
  return (
    <div className="flex items-baseline gap-2 px-2 py-0.5 text-[12px]">
      <span className="min-w-0 flex-1 truncate text-foreground/80">
        {member.title}
        {member.role === "lead" ? <span className="text-muted-foreground/60"> · lead</span> : null}
      </span>
      {member.role === "member" && yours > 0.00005 ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">
          incl. {formatTeamUsd(yours)} yours
        </span>
      ) : null}
      <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
        {formatTeamUsd(member.usd)}
      </span>
    </div>
  );
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
          <NetworkIcon aria-hidden className="mx-auto mb-3 size-5 text-muted-foreground/60" />
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
      <div className="flex items-center gap-2 px-2 pt-3">
        <NetworkIcon aria-hidden className="size-4 shrink-0 text-sky-600 dark:text-sky-300/80" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-[13px] text-foreground">{team.lead.title}</div>
          <div className="text-[11.5px] text-muted-foreground">
            {team.members.length} thread{team.members.length === 1 ? "" : "s"}
            {working > 0 ? ` · ${working} working` : team.stopped ? " · stopped" : ""}
            {team.cost.usd > 0 ? (
              <>
                {" · "}
                <span className="tabular-nums">{formatTeamUsd(team.cost.usd)}</span>
              </>
            ) : null}
            {team.cost.estimated ? (
              <span title="Includes an estimate for an interrupted step"> ~</span>
            ) : null}
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
        <div className="flex flex-col">
          {all.map((member) => (
            <div key={member.id} onClickCapture={() => keepPanelOn(member)}>
              <TeamMemberRow
                environmentId={threadRef.environmentId}
                here={member.threadId === threadRef.threadId}
                member={member}
              />
            </div>
          ))}
        </div>
      </Section>

      {team.board.length > 0 ? (
        <Section
          title="Board"
          aside={<NotebookPenIcon aria-hidden className="size-3 text-muted-foreground/50" />}
        >
          <div className="flex flex-col gap-1.5 px-1">
            {team.board.map((note) => (
              <div
                className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2"
                key={note.key}
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium font-mono text-[11.5px] text-foreground/85">
                    {note.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-muted-foreground/60">
                    {note.fromTitle}
                  </span>
                </div>
                <p className="mt-1 line-clamp-6 whitespace-pre-wrap text-[12px] text-foreground/75 leading-[1.55]">
                  {note.body}
                </p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {team.cost.usd > 0 ? (
        <Section title="Cost">
          {all.map((member) => (
            <CostLine key={member.id} member={member} />
          ))}
          <div className="mx-2 mt-1 flex items-baseline gap-2 border-border/50 border-t pt-1.5 text-[12.5px]">
            <span className="flex-1 font-medium text-foreground/90">Team total</span>
            <span className="font-medium text-foreground tabular-nums">
              {formatTeamUsd(team.cost.usd)}
            </span>
          </div>
        </Section>
      ) : null}
    </div>
  );
});
