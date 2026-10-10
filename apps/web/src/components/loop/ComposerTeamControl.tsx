/**
 * The composer footer's Team button — the Tasks button's twin, beside it.
 * Opens the team container (the right panel's Team surface: every thread with
 * its live state, one click to switch), and closes it again. Shown only in a
 * chat that is in a thread team; while threads work it carries their count.
 */
import { scopedThreadKey } from "@loop/runtime/environment";
import type { ScopedThreadRef } from "@loop/contracts";
import { NetworkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadTeam } from "./LoopTeam";
import { teamMemberWorking } from "./teamPresentation";

export const ComposerTeamControl = memo(function ComposerTeamControl({
  threadRef,
}: {
  threadRef: ScopedThreadRef | null;
}) {
  const team = useThreadTeam(threadRef);
  const open = useRightPanelStore((state) => {
    if (!threadRef) return false;
    const panel = state.byThreadKey[scopedThreadKey(threadRef)];
    return panel?.isOpen === true && panel.activeSurfaceId === "team";
  });
  if (!threadRef || !team) return null;
  const working = team.members.filter(teamMemberWorking).length;
  const toggle = () => {
    const store = useRightPanelStore.getState();
    if (open) store.close(threadRef);
    else store.open(threadRef, "team");
  };
  const tooltip = open ? "Hide team" : "Show team";
  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              aria-label={tooltip}
              className={cn(
                "shrink-0 whitespace-nowrap",
                open
                  ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                  : "text-muted-foreground/70 hover:text-foreground/80",
              )}
              onClick={toggle}
              type="button"
            />
          }
        >
          <ComposerControlIcon
            icon={NetworkIcon}
            className={open ? "text-current opacity-100" : undefined}
          />
          <span className="sr-only sm:not-sr-only">Team</span>
          <span className="tabular-nums opacity-70">
            {working > 0 ? `${working}/${team.members.length}` : team.members.length}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {tooltip}
          {working > 0 ? ` · ${working} working` : ""}
        </TooltipPopup>
      </Tooltip>
    </>
  );
});
