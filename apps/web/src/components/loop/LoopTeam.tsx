/**
 * Thread teams in the chat (packages/core/src/teams).
 *
 * Two kinds of thing show up in a conversation once a team exists:
 *
 * - Something the TEAM wrote into this thread: a member's brief from its lead,
 *   a message from a teammate, a report reaching the lead. Drawn as a card —
 *   the user never typed it, so it must not look like a user bubble.
 * - The team TOOLS this thread called: starting threads, waiting on them,
 *   messaging one, posting to the board, reporting. Starting and waiting are
 *   what you follow a team by, so the spawn card carries every thread's live
 *   state and opens it; the rest read as ordinary tool rows with names
 *   instead of ids.
 */
import type { ScopedThreadRef, TeamMember, TeamSnapshot } from "@loop/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  HourglassIcon,
  MailIcon,
  NetworkIcon,
  NotebookPenIcon,
  SendIcon,
  UsersIcon,
} from "lucide-react";
import { memo, useMemo } from "react";

import ChatMarkdown from "../ChatMarkdown";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { teamAtoms } from "../../state/team";
import type { LoopTeamEntry, LoopToolEntry } from "./loopEntry";
import { LaneDot, TintPill } from "./TeamRail";
import {
  formatTeamUsd,
  splitSpawnedMembers,
  teamLaneFor,
  teamMemberWorking,
  teamStatePresentation,
} from "./teamPresentation";

/** The team `threadRef`'s thread is in, live — null while it is in none (or loading). */
export function useThreadTeam(threadRef: ScopedThreadRef | null | undefined): TeamSnapshot | null {
  const atom = useMemo(
    () =>
      threadRef
        ? teamAtoms.team({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          })
        : null,
    [threadRef],
  );
  return useEnvironmentQuery(atom).data ?? null;
}

export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set([
  "spawn_threads",
  "send_message",
  "team_board",
  "wait_for_team",
  "report",
]);

export function StateDot({
  state,
  running = false,
  className,
}: {
  state: string;
  running?: boolean;
  className?: string;
}) {
  const look = teamStatePresentation(state, running);
  return (
    <span
      aria-label={look.label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        look.dotClass,
        look.pulse && "animate-status-pulse",
        className,
      )}
    />
  );
}

/** The left rail a tool row's nested content hangs from — the subagent log's. */
function Rail({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.5 ml-[22px] border-border/50 border-l pl-3">{children}</div>;
}

/** A tool-row head: icon, name, detail, status — the same grammar as LoopToolRow. */
function Head({
  icon,
  label,
  detail,
  status,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  detail?: React.ReactNode;
  status?: React.ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-1 py-1">
      {icon}
      <span
        className={cn(
          "shrink-0 font-medium text-[13px]",
          tone === "error" ? "text-destructive" : "text-foreground/85",
        )}
      >
        {label}
      </span>
      {detail ? (
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/75">
          {detail}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {status ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/55">{status}</span>
      ) : null}
    </div>
  );
}

const ICON = "size-3.5 shrink-0 text-muted-foreground/70";

/**
 * What a thread wrote — a brief, a message, a report — rendered as the
 * markdown it is, with the chat's own renderer: headings, tables, code and
 * `file:line` links read as they do in a reply, and a highlight-and-copy
 * still copies the markdown source.
 */
function Prose({
  text,
  cwd,
  threadRef,
}: {
  text: string;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
}) {
  return (
    <div className="py-0.5 text-[13px] text-foreground/85">
      <ChatMarkdown cwd={cwd} text={text.trim()} {...(threadRef ? { threadRef } : {})} />
    </div>
  );
}

type MessageKind = "brief" | "message" | "report" | "update";

const MESSAGE_KIND: Record<
  MessageKind,
  { label: string; icon: typeof MailIcon; chipClass: string }
> = {
  brief: { label: "Brief", icon: NetworkIcon, chipClass: "bg-chip-blue text-chip-blue-foreground" },
  message: {
    label: "Message",
    icon: MailIcon,
    chipClass: "bg-chip-violet text-chip-violet-foreground",
  },
  report: {
    label: "Report",
    icon: CircleCheckIcon,
    chipClass: "bg-chip-green text-chip-green-foreground",
  },
  update: {
    label: "Team update",
    icon: UsersIcon,
    chipClass: "bg-chip-neutral text-chip-neutral-foreground",
  },
};

/**
 * Something one thread wrote to another, as a card: what kind it is (a tinted
 * pill), who sent it (their name in their rail colour, opening their thread),
 * then the text. A card, not a bubble — the user never typed it.
 */
function TeamMessageCard({
  kind,
  sender,
  label,
  children,
}: {
  kind: MessageKind;
  sender?: React.ReactNode;
  /** Overrides the kind's own label ("Reported to the lead"). */
  label?: string;
  children: React.ReactNode;
}) {
  const look = MESSAGE_KIND[kind];
  const Icon = look.icon;
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-border bg-card/60">
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5 pb-1">
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1 rounded-lg px-1.5 font-medium text-[11px]",
            look.chipClass,
          )}
        >
          <Icon aria-hidden className="size-3" />
          {label ?? look.label}
        </span>
        {sender ? (
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            from {sender}
          </span>
        ) : null}
      </div>
      <div className="px-3 pb-2.5">{children}</div>
    </div>
  );
}

/** A thread's name in its rail colour, opening it when there is somewhere to open. */
function SenderPill({
  from,
  team,
  environmentId,
}: {
  from: { threadId: string; title: string };
  team: TeamSnapshot | null;
  environmentId: ScopedThreadRef["environmentId"] | undefined;
}) {
  const member = team ? [team.lead, ...team.members].find((m) => m.threadId === from.threadId) : null;
  const lane = teamLaneFor(team, member?.id ?? "");
  const pill = <TintPill className={cn("h-5 px-1.5 text-[11.5px]", lane.pillClass)}>{from.title}</TintPill>;
  if (!environmentId) return pill;
  return (
    <Link
      className="min-w-0 rounded-lg outline-hidden transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
      params={{ environmentId, threadId: from.threadId }}
      to="/$environmentId/$threadId"
    >
      {pill}
    </Link>
  );
}

/** What the team wrote into this thread: a brief, a message, a report. */
export const LoopTeamCard = memo(function LoopTeamCard({
  team: entry,
  threadRef,
  cwd,
}: {
  team: LoopTeamEntry;
  threadRef: ScopedThreadRef | null;
  /** Where relative file links in the text resolve from. */
  cwd?: string | undefined;
}) {
  const team = useThreadTeam(threadRef);
  const environmentId = threadRef?.environmentId;
  const sender = (from: { threadId: string; title: string }) => (
    <SenderPill environmentId={environmentId} from={from} team={team} />
  );

  if (entry.kind === "spawn") {
    const brief = (entry.text ?? "").replace(
      /\n\n\(Brief from "[^"]*"\. Your thread is "[^"]*"\. Call report when you are done\.\)$/,
      "",
    );
    return (
      <TeamMessageCard kind="brief" sender={entry.from ? sender(entry.from) : "the lead"}>
        <Prose cwd={cwd} text={brief} threadRef={threadRef} />
      </TeamMessageCard>
    );
  }

  return (
    <div className="py-px">
      {(entry.mail ?? []).map((mail) => {
        const kind: MessageKind =
          mail.kind === "report" ? "report" : mail.kind === "update" ? "update" : "message";
        return (
          <TeamMessageCard
            key={mail.id}
            kind={kind}
            {...(kind === "update" ? {} : { sender: sender(mail.from) })}
          >
            <Prose cwd={cwd} text={mail.text} threadRef={threadRef} />
          </TeamMessageCard>
        );
      })}
    </div>
  );
});

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/** A thread's title from the team, by session id — the id itself never reads as anything. */
function titleFor(team: TeamSnapshot | null, sessionId: string): string {
  if (!team) return "a thread";
  const member = [team.lead, ...team.members].find((m) => m.id === sessionId);
  return member ? member.title : "a thread";
}

/** One thread under the spawn row: its rail dot, title, what it is doing, its state. Opens it. */
function SpawnedThread({
  member,
  team,
  environmentId,
}: {
  member: TeamMember;
  team: TeamSnapshot | null;
  environmentId: ScopedThreadRef["environmentId"];
}) {
  const look = teamStatePresentation(member.state, member.running);
  const working = teamMemberWorking(member);
  return (
    <Link
      className="group/spawned -mx-1.5 flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-[12px] outline-hidden transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      params={{ environmentId, threadId: member.threadId }}
      to="/$environmentId/$threadId"
    >
      <LaneDot lane={teamLaneFor(team, member.id)} pulse={look.pulse} />
      <span className="shrink-0 text-foreground underline-offset-2 group-hover/spawned:underline">
        {member.title}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {working && member.activity ? (
          <span className="font-mono text-[11px]">{member.activity}</span>
        ) : null}
      </span>
      <TintPill className={cn("h-5 px-1.5 text-[11px]", look.chipClass)}>{look.label}</TintPill>
      {member.usd > 0 ? (
        <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
          {formatTeamUsd(member.usd)}
        </span>
      ) : null}
      <ChevronRightIcon
        aria-hidden
        className="size-3 shrink-0 text-muted-foreground/0 transition-colors group-hover/spawned:text-muted-foreground"
      />
    </Link>
  );
}

/** A team tool call in this thread's chat. */
export const LoopTeamToolRow = memo(function LoopTeamToolRow({
  tool,
  threadRef,
  cwd,
}: {
  tool: LoopToolEntry;
  threadRef: ScopedThreadRef | null;
  cwd?: string | undefined;
}) {
  const team = useThreadTeam(threadRef);
  const environmentId = threadRef?.environmentId;
  const failed = tool.isError && !tool.isPartial;

  if (tool.name === "spawn_threads") {
    const asked = Array.isArray(tool.args.threads)
      ? (tool.args.threads as Array<{ title?: unknown }>).map((t) =>
          typeof t?.title === "string" ? t.title : "",
        )
      : [];
    const members = team?.members ?? [];
    // This call's threads first; the rest of the team (earlier spawns, later
    // ones) underneath, so every thread the lead ever started stays one click
    // away from anywhere in the chat.
    const { started, others } = splitSpawnedMembers(members, tool.output, asked);
    const count = asked.length || started.length;
    const working = members.filter(teamMemberWorking).length;
    return (
      <div className="py-px">
        <Head
          icon={<NetworkIcon aria-hidden className={cn(ICON, tool.isPartial && "animate-pulse")} />}
          label={`${tool.isPartial ? "Starting" : failed ? "Could not start" : "Started"} ${count} thread${count === 1 ? "" : "s"}`}
          tone={failed ? "error" : "default"}
          {...(working > 0
            ? { status: `${working} working` }
            : team && team.cost.usd > 0
              ? { status: formatTeamUsd(team.cost.usd) }
              : {})}
        />
        <Rail>
          {started.length > 0 && environmentId
            ? started.map((member) => (
                <SpawnedThread
                  environmentId={environmentId}
                  key={member.id}
                  member={member}
                  team={team}
                />
              ))
            : failed
              ? null
              : asked.map((title, index) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div className="flex items-center gap-2 py-0.5 text-[12px]" key={index}>
                    <StateDot state="starting" />
                    <span className="text-foreground/80">{title}</span>
                  </div>
                ))}
          {others.length > 0 && environmentId ? (
            <>
              <div className="pt-1.5 pb-0.5 text-[11px] text-muted-foreground/60">
                Also in the team
              </div>
              {others.map((member) => (
                <SpawnedThread
                  environmentId={environmentId}
                  key={member.id}
                  member={member}
                  team={team}
                />
              ))}
            </>
          ) : null}
          {failed && tool.output ? (
            <p className="py-0.5 text-[12px] text-destructive">{tool.output}</p>
          ) : null}
        </Rail>
      </div>
    );
  }

  if (tool.name === "wait_for_team") {
    const until = tool.args.until;
    const what = Array.isArray(until)
      ? team
        ? `for ${until.map((id) => titleFor(team, String(id))).join(", ")}`
        : `for ${until.length} thread${until.length === 1 ? "" : "s"}`
      : until === "any"
        ? "for the next message"
        : "for every thread";
    const head = tool.output?.split("\n")[0] ?? "";
    return (
      <div className="py-px">
        <Head
          icon={
            <HourglassIcon
              aria-hidden
              className={cn(ICON, tool.isPartial && "animate-pulse text-warning")}
            />
          }
          label={`${tool.isPartial ? "Waiting" : "Waited"} ${what}`}
          {...(!tool.isPartial && head ? { detail: head } : {})}
        />
      </div>
    );
  }

  if (tool.name === "report") {
    return (
      <TeamMessageCard
        kind="report"
        label={tool.isPartial ? "Reporting to the lead" : "Reported to the lead"}
      >
        <Prose cwd={cwd} text={stringArg(tool.args, "summary")} threadRef={threadRef} />
      </TeamMessageCard>
    );
  }

  // send_message, team_board: named rather than addressed by id.
  const isMessage = tool.name === "send_message";
  const to = stringArg(tool.args, "to");
  const who = to === "all" ? "everyone" : titleFor(team, to);
  const label = isMessage
    ? `Message to ${who}`
    : stringArg(tool.args, "action") === "post"
      ? "Posted to the board"
      : "Read the team board";
  const detail = isMessage
    ? stringArg(tool.args, "message")
    : stringArg(tool.args, "key") || stringArg(tool.args, "content");
  const Icon = isMessage ? SendIcon : NotebookPenIcon;
  return (
    <div className="py-px">
      <Head
        icon={<Icon aria-hidden className={ICON} />}
        label={label}
        tone={failed ? "error" : "default"}
        {...(detail
          ? { detail: <span className={isMessage ? "" : "font-mono"}>{detail}</span> }
          : {})}
      />
    </div>
  );
});
