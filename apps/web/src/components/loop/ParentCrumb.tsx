/**
 * `parent /` ahead of a thread's title in the chat header: the way back to
 * the thread this one came from. Shared by thread teams (a member's lead) and
 * `/btw` side threads (the chat the question was asked in).
 */
import type { EnvironmentId } from "@loop/contracts";
import { Link } from "@tanstack/react-router";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ParentCrumb(props: {
  environmentId: EnvironmentId;
  threadId: string;
  title: string;
  /** What following the link does, e.g. "Back to the lead". */
  hint: string;
}) {
  return (
    <span className="inline-flex min-w-0 max-w-[40%] shrink items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              className="min-w-0 truncate rounded-sm font-medium text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              params={{ environmentId: props.environmentId, threadId: props.threadId }}
              to="/$environmentId/$threadId"
            />
          }
        >
          {props.title}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.hint}</TooltipPopup>
      </Tooltip>
      <span aria-hidden className="text-muted-foreground/40">
        /
      </span>
    </span>
  );
}
