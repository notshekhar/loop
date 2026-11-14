/**
 * A thread team drawn as a git graph: the lead sits on a trunk, every thread
 * branches off it to a dot in its own colour, and each row says who it is (a
 * name pill), what state it is in (a tinted chip), what it is doing and what
 * it has cost. Every row opens its thread.
 *
 * The trunk is drawn row by row — each member row paints its own piece of it
 * and its own branch — so rows of any height join up without measuring.
 */
import type { ScopedThreadRef, TeamMember, TeamSnapshot } from "@loop/contracts";
import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { cn } from "../../lib/utils";
import {
  formatTeamUsd,
  LEAD_LANE,
  teamLaneFor,
  teamMemberWorking,
  teamStatePresentation,
  type TeamLane,
} from "./teamPresentation";

/** Where the first line of a row is centred — the dots and branches aim here. */
const DOT_Y = 17;
/** The trunk's x; the branch dots sit one gutter step to its right. */
const TRUNK_X = 8;
const BRANCH_X = 24;

/**
 * The rail's one tone, for the trunk (a filled bar) and every branch (an SVG
 * stroke) alike, so lines never change colour where they meet. Colour per
 * thread lives on the dots and pills only.
 */
const RAIL_FILL = "bg-primary/45";
const RAIL_STROKE = "stroke-primary/45";

const TRUNK = cn("absolute w-0.5 -translate-x-1/2 rounded-full", RAIL_FILL);

/** A filled dot in a wash of its own hue — the reference's "blue dot in a dark-blue circle". */
export function LaneDot({
  lane,
  pulse = false,
  className,
  style,
}: {
  lane: TeamLane;
  pulse?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full",
        lane.haloClass,
        className,
      )}
      style={style}
    >
      <span
        className={cn("size-2 rounded-full", lane.dotClass, pulse && "animate-status-pulse")}
      />
    </span>
  );
}

/** A label in a tinted pill: rounded, no border, hue on a dark wash of itself. */
export function TintPill({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] min-w-0 items-center rounded-lg px-2 font-medium text-[12px] leading-none",
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The trunk piece and branch curve in a member row's gutter. */
function Branch({ last }: { last: boolean }) {
  const bend = DOT_Y - 6;
  return (
    <>
      <span
        aria-hidden
        className={TRUNK}
        style={{ left: TRUNK_X, top: 0, ...(last ? { height: bend } : { bottom: 0 }) }}
      />
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        fill="none"
        height={DOT_Y}
        width={BRANCH_X}
      >
        <path
          className={RAIL_STROKE}
          d={`M${TRUNK_X} ${bend - 1} Q${TRUNK_X} ${DOT_Y} ${TRUNK_X + 9} ${DOT_Y} H${BRANCH_X - 6}`}
          strokeLinecap="round"
          strokeWidth={2}
        />
      </svg>
    </>
  );
}

function RailRow({
  member,
  lane,
  environmentId,
  here,
  isLead,
  hasMembers,
  last,
}: {
  member: TeamMember;
  lane: TeamLane;
  environmentId: ScopedThreadRef["environmentId"];
  here: boolean;
  isLead: boolean;
  hasMembers: boolean;
  last: boolean;
}) {
  const look = teamStatePresentation(member.state, member.running);
  const working = teamMemberWorking(member);
  const dotLeft = (isLead ? TRUNK_X : BRANCH_X) - 8;
  return (
    <Link
      aria-label={`${member.title} — ${look.label}`}
      className={cn(
        "group/rail relative flex rounded-lg py-1.5 pr-2 outline-hidden transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
        here && "bg-accent/40",
      )}
      params={{ environmentId, threadId: member.threadId }}
      style={{ paddingLeft: (isLead ? TRUNK_X : BRANCH_X) + 14 }}
      to="/$environmentId/$threadId"
    >
      {isLead ? (
        hasMembers ? (
          <span aria-hidden className={TRUNK} style={{ left: TRUNK_X, top: DOT_Y + 8, bottom: 0 }} />
        ) : null
      ) : (
        <Branch last={last} />
      )}
      <LaneDot
        className="absolute"
        lane={lane}
        pulse={look.pulse}
        style={{ left: dotLeft, top: DOT_Y - 8 }}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex h-[22px] min-w-0 items-center gap-1.5">
          <TintPill className={lane.pillClass}>{member.title}</TintPill>
          {isLead ? (
            <span className="shrink-0 text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
              lead
            </span>
          ) : null}
          {here ? <span className="shrink-0 text-[11px] text-muted-foreground">· you are here</span> : null}
          <span className="min-w-0 flex-1" />
          <TintPill className={cn("h-5 px-1.5 text-[11px]", look.chipClass)}>{look.label}</TintPill>
          {member.usd > 0 ? (
            <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
              {formatTeamUsd(member.usd)}
            </span>
          ) : null}
        </span>
        {working && member.activity ? (
          <span className="truncate pl-0.5 font-mono text-[11px] text-muted-foreground">
            {member.activity}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

/** The whole team as a rail: the lead on top, its threads branching below. */
export const TeamRail = memo(function TeamRail({
  team,
  environmentId,
  currentThreadId,
  onOpen,
}: {
  team: TeamSnapshot;
  environmentId: ScopedThreadRef["environmentId"];
  /** The thread on screen, marked "you are here". */
  currentThreadId: string;
  /** Called as a row is opened, before the route changes. */
  onOpen?: (member: TeamMember) => void;
}) {
  return (
    <div className="flex flex-col">
      {[team.lead, ...team.members].map((member, index) => (
        <div key={member.id} onClickCapture={onOpen ? () => onOpen(member) : undefined}>
          <RailRow
            environmentId={environmentId}
            hasMembers={team.members.length > 0}
            here={member.threadId === currentThreadId}
            isLead={index === 0}
            lane={index === 0 ? LEAD_LANE : teamLaneFor(team, member.id)}
            last={index === team.members.length}
            member={member}
          />
        </div>
      ))}
    </div>
  );
});
