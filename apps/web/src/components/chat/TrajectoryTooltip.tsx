import type { ReactElement } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Keep the trace block itself as the tooltip anchor; extra wrappers would break its positioning. */
export function TrajectoryTooltip({
  children,
  label,
  side,
  delayMs = 500,
}: {
  children: ReactElement;
  label: string | (() => string);
  side: "bottom" | "right";
  delayMs?: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger delay={delayMs} render={children} />
      <TooltipPopup role="tooltip" side={side} className="whitespace-pre-line text-[11px]">
        {typeof label === "function" ? label() : label}
      </TooltipPopup>
    </Tooltip>
  );
}
