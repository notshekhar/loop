import { ArrowUpRightIcon, CornerDownRightIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  btwStatusOf,
  dismissBtwThread,
  type BtwStatus,
  type BtwThreadView,
} from "../../loop/useBtwThreads";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";

/**
 * `/btw` side questions asked from this thread, tucked under the composer.
 *
 * Built like the queued-messages strip (`chat-composer-tucked-strip`): inset,
 * pulled under the composer's top edge, so the answer reads as part of the
 * input rather than a card floating above it. Each question answers in its
 * own thread — loop copied this conversation and asked there — so nothing
 * here is part of this chat. "Open" goes to the side thread to follow up; the
 * cross only stops showing it here (the thread stays in the sidebar).
 */
export function ComposerBtwThreads({
  views,
  cwd,
  onOpen,
  className,
}: {
  readonly views: ReadonlyArray<BtwThreadView>;
  readonly cwd: string | undefined;
  readonly onOpen: (sessionId: string) => void;
  readonly className?: string | undefined;
}) {
  if (views.length === 0) return null;
  return (
    <div
      className={cn(
        "chat-composer-tucked-strip mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] flex-col px-2 pt-1.5 pb-5",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[11px] font-medium text-muted-foreground/70">
        <CornerDownRightIcon className="size-3 text-primary" aria-hidden />
        {views.length === 1 ? "Side question" : `Side questions · ${views.length}`}
        <span className="text-muted-foreground/50">· not part of this conversation</span>
      </div>
      {/* Several can be open at once, so the strip scrolls rather than
          growing until it pushes the composer off the screen. */}
      <ul className="flex max-h-56 flex-col divide-y divide-border/60 overflow-y-auto overscroll-contain">
        {views.map((view) => (
          <BtwRow key={view.thread.sessionId} view={view} cwd={cwd} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
}

/** Each status as a tinted pill. */
const STATUS_PILL: Record<BtwStatus, { label: string; className: string }> = {
  thinking: { label: "Thinking", className: "bg-chip-blue text-chip-blue-foreground" },
  answering: { label: "Answering", className: "bg-chip-blue text-chip-blue-foreground" },
  answered: { label: "Answered", className: "bg-chip-green text-chip-green-foreground" },
  failed: { label: "Failed", className: "bg-chip-red text-chip-red-foreground" },
};

function BtwRow({
  view,
  cwd,
  onOpen,
}: {
  readonly view: BtwThreadView;
  readonly cwd: string | undefined;
  readonly onOpen: (sessionId: string) => void;
}) {
  const status = STATUS_PILL[btwStatusOf(view)];
  return (
    <li className="group/btw flex flex-col gap-1 px-1 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
          {view.thread.question}
        </span>
        <span className={cn("shrink-0 rounded-md px-1.5 py-px text-[10px] font-medium", status.className)}>
          {status.label}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground/60 hover:text-foreground"
          aria-label="Open the side thread to follow up"
          onClick={() => onOpen(view.thread.sessionId)}
        >
          <ArrowUpRightIcon className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground/60 hover:text-foreground"
          aria-label="Stop showing this side question"
          onClick={() => dismissBtwThread(view.thread.sessionId)}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      {view.error ? (
        <p className="text-xs text-destructive">{view.error}</p>
      ) : view.answer ? (
        <div className="text-[13px] text-muted-foreground">
          <ChatMarkdown text={view.answer} cwd={cwd} isStreaming={view.running} />
        </div>
      ) : null}
    </li>
  );
}
