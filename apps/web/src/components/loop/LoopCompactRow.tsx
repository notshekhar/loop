/**
 * Where the context was compacted.
 *
 * loop replaces everything before a cut point with a summary, either on its
 * own once the context passes `autoCompactThreshold` or because someone ran
 * `/compact`. Nothing in the transcript changes visually when that happens —
 * the earlier messages are still on screen — but the model can no longer see
 * them, and without a marker the next reply reads as the agent having
 * forgotten the conversation.
 *
 * So it draws as a divider across the thread rather than as another message:
 * it is a statement ABOUT the conversation, not part of it. The summary is
 * what the model now sees in place of everything above, so it is available,
 * folded away by default because it is long and rarely the thing you want.
 */
import { ChevronDownIcon, ChevronRightIcon, ScissorsIcon } from "lucide-react";
import { memo, useState } from "react";
import { formatTokens } from "@loop/format";

import { cn } from "../../lib/utils";
import type { LoopCompactEntry } from "./loopEntry";


/** The one-line claim the divider makes. */
export function compactLabel(compact: LoopCompactEntry): string {
  if (compact.running) return "Compacting context…";
  if (compact.aborted) return "Compaction cancelled";
  if (compact.error) return `Compaction failed · ${compact.error}`;
  const { tokensBefore, tokensAfter } = compact;
  // Both counts or neither: "148k → " with a missing half reads as a bug.
  if (tokensBefore !== undefined && tokensAfter !== undefined) {
    return `Context compacted · ${formatTokens(tokensBefore)} → ${formatTokens(tokensAfter)} tokens`;
  }
  return "Context compacted";
}

export const LoopCompactRow = memo(function LoopCompactRow({
  compact,
}: {
  compact: LoopCompactEntry;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = compact.summary !== undefined;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "h-px flex-1",
            compact.aborted ? "bg-border/40" : "bg-border/70",
          )}
        />
        <button
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-0.5 text-[11px]",
            compact.aborted ? "text-muted-foreground/50" : "text-muted-foreground/75",
            canExpand
              ? "cursor-pointer hover:border-border hover:text-foreground/80"
              : "cursor-default",
          )}
          disabled={!canExpand}
          onClick={canExpand ? () => setExpanded((value) => !value) : undefined}
          type="button"
        >
          <ScissorsIcon
            aria-hidden
            className={cn("size-3 shrink-0", compact.running && "animate-pulse")}
          />
          <span>{compactLabel(compact)}</span>
          {compact.reason ? (
            <span className="text-muted-foreground/45">({compact.reason})</span>
          ) : null}
          {canExpand ? (
            expanded ? (
              <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
            )
          ) : null}
        </button>
        <span
          aria-hidden
          className={cn("h-px flex-1", compact.aborted ? "bg-border/40" : "bg-border/70")}
        />
      </div>

      {expanded && compact.summary ? (
        <div className="mt-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
          <p className="font-medium text-[11px] text-muted-foreground/60 uppercase tracking-wide">
            What the model sees instead
          </p>
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-muted-foreground leading-[1.6]">
            {compact.summary}
          </p>
        </div>
      ) : null}
    </div>
  );
});
