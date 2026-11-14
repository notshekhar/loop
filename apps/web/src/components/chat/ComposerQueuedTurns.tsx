import { CornerDownLeftIcon, ImageIcon, XIcon } from "lucide-react";

import type { QueuedTurn } from "../../queuedTurnsStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Messages waiting behind the running turn, above the composer.
 *
 * The counterpart to the run-context strip below it, and deliberately built the
 * same way — inset, tucked under the composer's corner curve — so the input
 * keeps reading as one object with a strip on each side rather than three
 * stacked cards.
 *
 * Every row can be taken back. That is the whole reason the queue is visible at
 * all: a message held somewhere the user cannot see or cancel is
 * indistinguishable from one that was swallowed, which is exactly how queueing
 * felt before this existed.
 *
 * And every row can be sent NOW, which is the terminal's Esc: once you have
 * decided the running turn is going the wrong way, waiting for it to finish is
 * the one thing you do not want to do. Stop would have thrown the message away
 * with the turn.
 */
export function ComposerQueuedTurns({
  turns,
  onCancel,
  onSendNow,
  className,
}: {
  readonly turns: ReadonlyArray<QueuedTurn>;
  readonly onCancel: (id: string) => void;
  /** Interrupt the running turn and send this message instead. */
  readonly onSendNow?: (id: string) => void;
  readonly className?: string;
}) {
  if (turns.length === 0) return null;

  return (
    <div
      className={cn(
        "chat-composer-tucked-strip mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] flex-col gap-0.5 px-2 pt-1.5 pb-5",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[11px] font-medium text-muted-foreground/70">
        <span className="inline-flex size-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
        {turns.length === 1 ? "Queued" : `Queued · ${turns.length}`}
      </div>
      {/* Any number can be queued, so the strip scrolls rather than growing
          until it pushes the composer off the screen. */}
      <ul className="flex max-h-28 flex-col gap-0.5 overflow-y-auto overscroll-contain">
        {turns.map((turn) => (
          <li key={turn.id} className="group/queued flex items-center gap-1.5 rounded-md px-1">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/85">
              {/* Collapsed to one line: the composer already showed the user
                  what they typed, and a queue that grows a paragraph tall
                  pushes the input off the screen. */}
              {turn.text.trim().replace(/\s+/g, " ") || "Attachment"}
            </span>
            {turn.attachmentCount > 0 && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground/60"
                aria-label={`${turn.attachmentCount} attachments`}
              >
                <ImageIcon className="size-3" />
                {turn.attachmentCount}
              </span>
            )}
            {onSendNow ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/queued:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                      aria-label="Send this message now"
                      onClick={() => onSendNow(turn.id)}
                    />
                  }
                >
                  <CornerDownLeftIcon className="size-3" />
                </TooltipTrigger>
                {/* Named for what it costs, not just what it does: this stops
                    the turn that is running. */}
                <TooltipPopup side="top">Stop the turn and send this</TooltipPopup>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/queued:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    aria-label="Remove queued message"
                    onClick={() => onCancel(turn.id)}
                  />
                }
              >
                <XIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Remove from queue</TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}
