/**
 * A thread team in the chat header, in the header's own idiom.
 *
 * - In a thread, its lead joins the breadcrumb — `project / lead / thread` —
 *   so the way back is where the eye already reads where it is.
 * - In any chat of a team, a team icon sits with the header's other icons
 *   (branches, cost) and opens the team panel; while threads work it carries
 *   their count.
 *
 * Nothing renders for a chat in no team.
 */
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@loop/contracts";
import { Link } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadTeam } from "./LoopTeam";
import { teamMemberWorking } from "./teamPresentation";

function useRef(environmentId: EnvironmentId, threadId: ThreadId): ScopedThreadRef {
  return useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
}

/** `lead /` ahead of a thread's title — nothing for the lead or a chat in no team. */
export const TeamLeadCrumb = memo(function TeamLeadCrumb(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const threadRef = useRef(props.environmentId, props.threadId);
  const team = useThreadTeam(threadRef);
  if (!team || team.lead.threadId === props.threadId) return null;
  return (
    <span className="inline-flex min-w-0 max-w-[40%] shrink items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              className="min-w-0 truncate rounded-sm font-medium text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              params={{ environmentId: props.environmentId, threadId: team.lead.threadId }}
              to="/$environmentId/$threadId"
            />
          }
        >
          {team.lead.title}
        </TooltipTrigger>
        <TooltipPopup side="top">Back to the lead</TooltipPopup>
      </Tooltip>
      <span aria-hidden className="text-muted-foreground/40">
        /
      </span>
    </span>
  );
});

/** The header's team icon: opens the team panel. */
export const TeamHeaderButton = memo(function TeamHeaderButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const threadRef = useRef(props.environmentId, props.threadId);
  const team = useThreadTeam(threadRef);
  if (!team) return null;
  const working = team.members.filter(teamMemberWorking).length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label="Thread team"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => useRightPanelStore.getState().open(threadRef, "team")}
            type="button"
          />
        }
      >
        <NetworkIcon aria-hidden className="size-4 shrink-0" />
        <span className="tabular-nums">{working > 0 ? working : team.members.length}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {working > 0
          ? `${working} of ${team.members.length} threads working`
          : `Team · ${team.members.length} threads`}
      </TooltipPopup>
    </Tooltip>
  );
});
