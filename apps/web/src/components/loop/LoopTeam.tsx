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

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { teamAtoms } from "../../state/team";
import type { LoopTeamEntry, LoopToolEntry } from "./loopEntry";
import { formatTeamUsd, teamMemberWorking, teamStatePresentation } from "./teamPresentation";

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

/** One thread of the team as a row that opens it. */
export const TeamMemberRow = memo(function TeamMemberRow({
  member,
  environmentId,
  here,
  showCost = true,
}: {
  member: TeamMember;
  environmentId: ScopedThreadRef["environmentId"];
  here: boolean;
  showCost?: boolean;
}) {
  const look = teamStatePresentation(member.state, member.running);
  const working = teamMemberWorking(member);
  return (
    <Link
      className={cn(
        "group/member flex items-center gap-2 rounded-md px-2 py-1.5 outline-hidden transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
        here && "bg-accent/30",
      )}
      params={{ environmentId, threadId: member.threadId }}
      to="/$environmentId/$threadId"
    >
      <StateDot running={member.running} state={member.state} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate font-medium text-[12.5px] text-foreground/90">
            {member.title}
          </span>
          {member.role === "lead" ? (
            <span className="shrink-0 text-[10.5px] text-muted-foreground/60 uppercase tracking-[0.04em]">
              lead
            </span>
          ) : null}
        </span>
        <span className="block truncate text-[11.5px] text-muted-foreground/70">
          <span className={look.textClass}>{look.label}</span>
          {working && member.activity ? (
            <span className="font-mono"> · {member.activity}</span>
          ) : null}
          {here ? <span> · here</span> : null}
        </span>
      </span>
      {showCost && member.usd > 0 ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
          {formatTeamUsd(member.usd)}
        </span>
      ) : null}
    </Link>
  );
});

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

function Prose({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap py-0.5 text-[12.5px] text-foreground/75 leading-[1.6]">
      {text.trim()}
    </p>
  );
}

/** What the team wrote into this thread: a brief, a message, a report. */
export const LoopTeamCard = memo(function LoopTeamCard({
  team,
  threadRef,
}: {
  team: LoopTeamEntry;
  threadRef: ScopedThreadRef | null;
}) {
  const environmentId = threadRef?.environmentId;
  const sender = (from: { threadId: string; title: string }) =>
    environmentId ? (
      <Link
        className="text-foreground/85 underline-offset-2 hover:underline"
        params={{ environmentId, threadId: from.threadId }}
        to="/$environmentId/$threadId"
      >
        {from.title}
      </Link>
    ) : (
      <span className="text-foreground/85">{from.title}</span>
    );

  if (team.kind === "spawn") {
    const brief = (team.text ?? "").replace(
      /\n\n\(Brief from "[^"]*"\. Your thread is "[^"]*"\. Call report when you are done\.\)$/,
      "",
    );
    return (
      <div className="py-px">
        <Head
          icon={<NetworkIcon aria-hidden className={ICON} />}
          label="Brief"
          detail={<>from {team.from ? sender(team.from) : "the lead"}</>}
        />
        <Rail>
          <Prose text={brief} />
        </Rail>
      </div>
    );
  }

  return (
    <div className="py-px">
      {(team.mail ?? []).map((mail) => {
        const report = mail.kind === "report";
        const update = mail.kind === "update";
        const Icon = report ? CircleCheckIcon : update ? UsersIcon : MailIcon;
        return (
          <div key={mail.id}>
            <Head
              icon={
                <Icon
                  aria-hidden
                  className={cn(ICON, report && "text-emerald-600 dark:text-emerald-300/90")}
                />
              }
              label={update ? "Team update" : report ? "Report" : "Message"}
              {...(update ? {} : { detail: <>from {sender(mail.from)}</> })}
            />
            <Rail>
              <Prose text={mail.text} />
            </Rail>
          </div>
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

/** One thread under the spawn row: dot, title, what it is doing. Opens it. */
function SpawnedThread({
  member,
  environmentId,
}: {
  member: TeamMember;
  environmentId: ScopedThreadRef["environmentId"];
}) {
  const look = teamStatePresentation(member.state, member.running);
  const working = teamMemberWorking(member);
  return (
    <Link
      className="group/spawned -mx-1.5 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12px] outline-hidden transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      params={{ environmentId, threadId: member.threadId }}
      to="/$environmentId/$threadId"
    >
      <StateDot running={member.running} state={member.state} />
      <span className="shrink-0 text-foreground/80 underline-offset-2 group-hover/spawned:text-foreground group-hover/spawned:underline">
        {member.title}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground/55">
        {working && member.activity ? (
          <span className="font-mono text-[11.5px]">{member.activity}</span>
        ) : null}
      </span>
      <span className={cn("shrink-0 text-[11px]", look.textClass)}>{look.label}</span>
      {member.usd > 0 ? (
        <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground/50 tabular-nums">
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
}: {
  tool: LoopToolEntry;
  threadRef: ScopedThreadRef | null;
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
    const count = asked.length || members.length;
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
          {members.length > 0 && environmentId
            ? members.map((member) => (
                <SpawnedThread environmentId={environmentId} key={member.id} member={member} />
              ))
            : asked.map((title, index) => (
                // eslint-disable-next-line react/no-array-index-key
                <div className="flex items-center gap-2 py-0.5 text-[12px]" key={index}>
                  <StateDot state="starting" />
                  <span className="text-foreground/80">{title}</span>
                </div>
              ))}
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
      <div className="py-px">
        <Head
          icon={
            <CircleCheckIcon
              aria-hidden
              className={cn(ICON, "text-emerald-600 dark:text-emerald-300/90")}
            />
          }
          label={tool.isPartial ? "Reporting to the lead" : "Reported to the lead"}
        />
        <Rail>
          <Prose text={stringArg(tool.args, "summary")} />
        </Rail>
      </div>
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
