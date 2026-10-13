/**
 * A pull request's Conversation tab: comments, reviews and line threads in
 * the order they happened, each drawn with the chat's own markdown, and a box
 * to add to it. The thread and comment box are shared with the Files tab,
 * where threads sit on their lines.
 */
import type { LoopPullRequestTimelineItem } from "@loop/contracts";
import { BotIcon, FileCodeIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { reviewStateTone, shortAge } from "./pullRequestPresentation";

type ThreadItem = Extract<LoopPullRequestTimelineItem, { kind: "thread" }>;

/** A comment box: Cmd/Ctrl+Enter sends, Escape cancels when it can. */
export function PullRequestCommentBox(props: {
  readonly label?: string;
  readonly placeholder?: string;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly autoFocus?: boolean;
  readonly onSubmit: (body: string) => Promise<boolean>;
  readonly onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // The diff view re-renders the row an annotation is slotted into a frame
  // after mounting it, which steals focus from autoFocus (see
  // LocalCommentAnnotation) — so take it again a frame later.
  useEffect(() => {
    if (!props.autoFocus) return;
    ref.current?.focus();
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.autoFocus]);

  const send = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    const ok = await props.onSubmit(body);
    setSending(false);
    if (ok) setBody("");
  };

  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-background p-2.5 shadow-xs">
      {props.label ? <p className="px-0.5 text-xs font-medium text-muted-foreground">{props.label}</p> : null}
      <Textarea
        ref={ref}
        value={body}
        placeholder={props.placeholder ?? "Leave a comment (Markdown works)"}
        className="min-h-20 text-sm"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          } else if (event.key === "Escape" && props.onCancel) {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        {props.onCancel ? (
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" disabled={!body.trim() || sending || props.busy} onClick={() => void send()}>
          {sending ? <Spinner className="size-3" /> : null}
          {props.submitLabel}
        </Button>
      </div>
    </div>
  );
}

function Author(props: { readonly login: string | undefined; readonly isBot?: boolean | undefined }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium text-foreground">
      {props.isBot ? <BotIcon className="size-3.5 text-muted-foreground" /> : null}
      {props.login ?? "someone"}
    </span>
  );
}

function Body(props: { readonly text: string; readonly cwd: string | undefined }) {
  if (!props.text.trim()) return null;
  return (
    <div className="min-w-0 text-sm select-text [-webkit-user-select:text]">
      <ChatMarkdown text={props.text} cwd={props.cwd} />
    </div>
  );
}

/** The hunk a thread was left on: the last few lines, ending at the commented one. */
function HunkExcerpt(props: { readonly hunk: string }) {
  const lines = props.hunk.split("\n").slice(1).slice(-4);
  if (lines.length === 0) return null;
  return (
    <pre className="overflow-x-auto border-b border-border/60 bg-muted/30 px-3 py-1.5 font-mono text-[11px] leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            line.startsWith("+") && "text-success-foreground",
            line.startsWith("-") && "text-destructive-foreground",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export function PullRequestThread(props: {
  readonly thread: ThreadItem;
  readonly busy: boolean;
  /** In the Files tab the file and hunk are already on screen. */
  readonly compact?: boolean;
  readonly cwd?: string;
  readonly onReply: (body: string) => Promise<boolean>;
}) {
  const { thread } = props;
  const [replying, setReplying] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
      {props.compact ? null : (
        <>
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
            <FileCodeIcon className="size-3.5" />
            <span className="truncate font-mono">{thread.path}</span>
            {thread.line === null ? (
              <span className="ml-auto rounded bg-muted px-1.5 text-[10px]">Outdated</span>
            ) : (
              <span className="ml-auto font-mono">L{thread.line}</span>
            )}
          </div>
          <HunkExcerpt hunk={thread.diffHunk} />
        </>
      )}
      <div className="divide-y divide-border/50">
        {thread.comments.map((comment) => (
          <div key={comment.id} className="space-y-1 px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Author login={comment.author?.login} isBot={comment.author?.isBot} />
              <span>{shortAge(comment.createdAt)}</span>
            </div>
            <Body text={comment.body} cwd={props.cwd} />
          </div>
        ))}
      </div>
      <div className="border-t border-border/60 px-3 py-2">
        {replying ? (
          <PullRequestCommentBox
            autoFocus
            submitLabel="Reply"
            placeholder="Reply…"
            busy={props.busy}
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              const ok = await props.onReply(body);
              if (ok) setReplying(false);
              return ok;
            }}
          />
        ) : (
          <button
            type="button"
            className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setReplying(true)}
          >
            Reply…
          </button>
        )}
      </div>
    </div>
  );
}

export function PullRequestConversation(props: {
  readonly timeline: ReadonlyArray<LoopPullRequestTimelineItem> | null;
  readonly error: string | null;
  readonly cwd: string;
  readonly busy: boolean;
  readonly onComment: (body: string) => Promise<boolean>;
  readonly onReply: (commentId: number, body: string) => Promise<boolean>;
}) {
  const { timeline } = props;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 px-5 py-4">
      {props.error && !timeline ? (
        <p className="text-sm text-destructive-foreground">{props.error}</p>
      ) : !timeline ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" /> Loading the conversation…
        </p>
      ) : timeline.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <MessageSquareIcon className="size-4" /> No comments yet.
        </p>
      ) : (
        timeline.map((item) => {
          if (item.kind === "thread") {
            return (
              <PullRequestThread
                key={`thread-${item.id}`}
                thread={item}
                cwd={props.cwd}
                busy={props.busy}
                onReply={(body) => props.onReply(item.id, body)}
              />
            );
          }
          const tone = item.kind === "review" ? reviewStateTone(item.state) : null;
          return (
            <div key={`${item.kind}-${item.id}`} className="rounded-xl border border-border/70 bg-card px-3 py-2.5">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <Author login={item.author?.login} isBot={item.author?.isBot} />
                {tone ? (
                  <span className={cn("inline-flex items-center gap-1 font-medium", tone.textClass)}>
                    <span className={cn("size-1.5 rounded-full", tone.dotClass)} />
                    {tone.label}
                  </span>
                ) : (
                  <span>commented</span>
                )}
                <span>{shortAge(item.createdAt)}</span>
              </div>
              <Body text={item.body} cwd={props.cwd} />
            </div>
          );
        })
      )}
      <PullRequestCommentBox submitLabel="Comment" busy={props.busy} onSubmit={props.onComment} />
    </div>
  );
}
