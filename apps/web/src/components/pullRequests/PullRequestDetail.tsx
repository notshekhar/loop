/**
 * One pull request on the desktop: its header and actions, then four tabs —
 * Overview (description, checks, reviewers), Conversation, Files and Commits.
 *
 * Actions run through `gh` on the host and refresh what they change. A merge
 * or a review asks first in a small dialog; closing asks too. Nothing here
 * touches the user's working copy: merging never deletes the local branch.
 */
import type { LoopPullRequestDetail } from "@loop/contracts";
import {
  CheckIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { PullRequestConversation } from "./PullRequestConversation";
import { PullRequestFiles } from "./PullRequestFiles";
import {
  checkTone,
  checksTone,
  reviewLabel,
  reviewStateTone,
  shortAge,
  stateTone,
} from "./pullRequestPresentation";
import {
  openExternalUrl,
  usePullRequestAction,
  usePullRequestConversation,
  usePullRequestDetail,
  type PullRequestScope,
} from "./usePullRequests";

export type PullRequestTab = "overview" | "conversation" | "files" | "commits";
const TABS: ReadonlyArray<{ value: PullRequestTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "conversation", label: "Conversation" },
  { value: "files", label: "Files" },
  { value: "commits", label: "Commits" },
];

type MergeMethod = "squash" | "merge" | "rebase";
const MERGE_METHODS: ReadonlyArray<{ value: MergeMethod; label: string; detail: string }> = [
  { value: "squash", label: "Squash and merge", detail: "One commit on the base branch." },
  { value: "merge", label: "Create a merge commit", detail: "Every commit, plus a merge commit." },
  { value: "rebase", label: "Rebase and merge", detail: "Every commit, replayed on the base." },
];

type ReviewEvent = "comment" | "approve" | "request_changes";
const REVIEW_EVENTS: ReadonlyArray<{ value: ReviewEvent; label: string; detail: string }> = [
  { value: "comment", label: "Comment", detail: "Feedback without approving." },
  { value: "approve", label: "Approve", detail: "Good to merge." },
  { value: "request_changes", label: "Request changes", detail: "Must be addressed before merging." },
];

function Section(props: { readonly title: string; readonly trailing?: string; readonly children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-baseline justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
        {props.trailing ? <span className="tabular-nums normal-case">{props.trailing}</span> : null}
      </h3>
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card">{props.children}</div>
    </section>
  );
}

function RadioRows<T extends string>(props: {
  readonly options: ReadonlyArray<{ value: T; label: string; detail: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => props.onChange(option.value)}
          className={cn(
            "flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left",
            props.value === option.value ? "border-primary/60 bg-primary/5" : "border-border hover:bg-accent/40",
          )}
        >
          <span
            className={cn(
              "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
              props.value === option.value ? "border-primary bg-primary" : "border-input",
            )}
          >
            {props.value === option.value ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
          </span>
          <span>
            <span className="block text-sm font-medium text-foreground">{option.label}</span>
            <span className="block text-xs text-muted-foreground">{option.detail}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Overview(props: { readonly pr: LoopPullRequestDetail; readonly cwd: string }) {
  const { pr } = props;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-5 py-4">
      <Section title="Description">
        <div className="px-4 py-3 text-sm select-text [-webkit-user-select:text]">
          {pr.body.trim() ? (
            <ChatMarkdown text={pr.body} cwd={props.cwd} />
          ) : (
            <p className="text-muted-foreground italic">No description.</p>
          )}
        </div>
      </Section>

      {pr.checkRuns.length > 0 ? (
        <Section title="Checks" trailing={String(pr.checkRuns.length)}>
          <div className="divide-y divide-border/50">
            {pr.checkRuns.map((check, index) => {
              const tone = checkTone(check);
              return (
                <button
                  key={`${check.name}-${index}`}
                  type="button"
                  disabled={!check.url}
                  onClick={() => openExternalUrl(check.url)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left enabled:cursor-pointer enabled:hover:bg-accent/40"
                >
                  <span className={cn("size-2 shrink-0 rounded-full", tone.dotClass)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{check.name}</span>
                    {check.workflow ? (
                      <span className="block truncate text-xs text-muted-foreground">{check.workflow}</span>
                    ) : null}
                  </span>
                  <span className={cn("text-xs font-medium", tone.textClass)}>{tone.label}</span>
                </button>
              );
            })}
          </div>
        </Section>
      ) : null}

      {pr.reviewers.length > 0 ? (
        <Section title="Reviewers">
          <div className="divide-y divide-border/50">
            {pr.reviewers.map((reviewer) => {
              const tone = reviewStateTone(reviewer.state);
              return (
                <div key={reviewer.login} className="flex items-center justify-between px-4 py-2">
                  <span className="text-sm text-foreground">{reviewer.login}</span>
                  <span className={cn("text-xs font-medium", tone.textClass)}>{tone.label}</span>
                </div>
              );
            })}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function Commits(props: { readonly pr: LoopPullRequestDetail }) {
  const commits = props.pr.commits ?? [];
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-4">
      {commits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commits to show.</p>
      ) : (
        <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70 bg-card">
          {commits.map((commit) => (
            <div key={commit.oid} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{commit.headline}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {commit.author ?? ""} {shortAge(commit.committedAt)}
              </span>
              <code className="shrink-0 font-mono text-xs text-muted-foreground">{commit.oid.slice(0, 7)}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PullRequestDetail(props: {
  readonly scope: PullRequestScope;
  readonly number: number;
  readonly tab: PullRequestTab;
  readonly onTabChange: (tab: PullRequestTab) => void;
  readonly onChanged: () => void;
  readonly onReviewWithLoop: (pr: LoopPullRequestDetail) => void;
}) {
  const { scope, number } = props;
  const detail = usePullRequestDetail(scope, number);
  const conversation = usePullRequestConversation(scope, number);
  const { perform, pending } = usePullRequestAction(scope, number);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>("comment");
  const [reviewBody, setReviewBody] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [viewed, setViewed] = useState<ReadonlyMap<string, boolean>>(new Map());

  // Overrides belong to one PR; GitHub's own state takes over once re-read.
  useEffect(() => setViewed(new Map()), [number, detail.data]);

  const pr = detail.data;
  const refreshAll = useCallback(() => {
    detail.refresh();
    conversation.refresh();
    props.onChanged();
  }, [conversation, detail, props]);

  const toggleViewed = useCallback(
    (path: string, next: boolean) => {
      if (!pr?.nodeId) return;
      setViewed((prev) => new Map(prev).set(path, next));
      void perform({ kind: "viewed", nodeId: pr.nodeId, path, viewed: next }).then((ok) => {
        if (!ok) {
          setViewed((prev) => {
            const map = new Map(prev);
            map.delete(path);
            return map;
          });
        }
      });
    },
    [perform, pr?.nodeId],
  );

  if (detail.error && !pr) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-md text-sm text-destructive-foreground">{detail.error}</p>
        <Button variant="outline" size="sm" onClick={detail.refresh}>
          Try again
        </Button>
      </div>
    );
  }
  if (!pr) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Loading #{number}…
      </div>
    );
  }

  const state = stateTone(pr);
  const checks = checksTone(pr.checks);
  const review = reviewLabel(pr.reviewDecision);
  const busy = pending !== null;
  const isOpen = pr.state === "open";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="space-y-2 border-b border-border/70 px-5 pt-4 pb-0">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-lg leading-snug font-semibold text-foreground select-text">
            {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
          </h2>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh"
              onClick={refreshAll}
              disabled={detail.isPending}
            >
              <RefreshCwIcon className={cn(detail.isPending && "animate-spin")} />
            </Button>
            <Button size="sm" variant="outline" onClick={() => props.onReviewWithLoop(pr)}>
              <SparklesIcon /> Review with loop
            </Button>
            <Button size="sm" variant="outline" onClick={() => openExternalUrl(pr.url)}>
              <ExternalLinkIcon /> GitHub
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1.5 font-medium", state.textClass)}>
            <span className={cn("size-2 rounded-full", state.dotClass)} />
            {state.label}
          </span>
          <span>
            {pr.author?.login ?? "someone"}{" "}
            {pr.state === "merged" ? "merged" : pr.state === "closed" ? "proposed" : "wants to merge"}{" "}
            {pr.commitCount} commit{pr.commitCount === 1 ? "" : "s"} into{" "}
            <code className="font-mono">{pr.baseRef}</code> from <code className="font-mono">{pr.headRef}</code>
          </span>
          <span className="tabular-nums">
            <span className="text-success-foreground">+{pr.additions}</span>{" "}
            <span className="text-destructive-foreground">−{pr.deletions}</span>
          </span>
          {checks ? <span className={cn("font-medium", checks.textClass)}>{checks.label}</span> : null}
          {review ? <span>{review}</span> : null}
          {isOpen && pr.mergeable === "conflicting" ? (
            <span className="font-medium text-destructive-foreground">Has conflicts</span>
          ) : null}
          {pr.labels.map((label) => (
            <span key={label.name} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground/80">
              {label.name}
            </span>
          ))}
        </div>

        {isOpen ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Button size="sm" onClick={() => setReviewOpen(true)} disabled={busy}>
              <CheckIcon /> Review
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMergeOpen(true)}
              disabled={busy || pr.isDraft || pr.mergeable === "conflicting"}
            >
              <GitMergeIcon /> Merge
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void perform({ kind: pr.isDraft ? "ready" : "draft" }, refreshAll)}
            >
              {pending === "ready" || pending === "draft" ? (
                <Spinner className="size-3" />
              ) : (
                <GitPullRequestDraftIcon />
              )}
              {pr.isDraft ? "Ready for review" : "Convert to draft"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCloseOpen(true)}>
              <GitPullRequestClosedIcon /> Close
            </Button>
          </div>
        ) : pr.state === "closed" ? (
          <div className="pt-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void perform({ kind: "reopen" }, refreshAll)}
            >
              {pending === "reopen" ? <Spinner className="size-3" /> : null}
              Reopen
            </Button>
          </div>
        ) : null}

        <nav className="-mb-px flex gap-4 pt-1" aria-label="Pull request sections">
          {TABS.map((tab) => {
            const count =
              tab.value === "conversation"
                ? conversation.data?.length
                : tab.value === "files"
                  ? pr.files.length
                  : tab.value === "commits"
                    ? pr.commitCount
                    : undefined;
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => props.onTabChange(tab.value)}
                className={cn(
                  "cursor-pointer border-b-2 pb-2 text-sm",
                  props.tab === tab.value
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {count !== undefined ? (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{count}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
      </header>

      {props.tab === "files" ? (
        <PullRequestFiles
          scope={scope}
          pr={pr}
          timeline={conversation.data ?? []}
          busy={busy}
          viewedOverrides={viewed}
          onToggleViewed={toggleViewed}
          onReply={(commentId, body) => perform({ kind: "reply", commentId, body }, conversation.refresh)}
          onComment={(input) =>
            pr.headSha
              ? perform(
                  {
                    kind: "line_comment",
                    path: input.path,
                    line: input.line,
                    ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
                    side: input.side,
                    commitId: pr.headSha,
                    body: input.body,
                  },
                  conversation.refresh,
                )
              : Promise.resolve(false)
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {props.tab === "overview" ? (
            <Overview pr={pr} cwd={scope.cwd} />
          ) : props.tab === "conversation" ? (
            <PullRequestConversation
              timeline={conversation.data}
              error={conversation.error}
              cwd={scope.cwd}
              busy={busy}
              onComment={(body) => perform({ kind: "comment", body }, conversation.refresh)}
              onReply={(commentId, body) => perform({ kind: "reply", commentId, body }, conversation.refresh)}
            />
          ) : (
            <Commits pr={pr} />
          )}
        </div>
      )}

      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Review #{pr.number}</DialogTitle>
            <DialogDescription>
              Line comments you've left in Files are already on GitHub; this adds your overall
              verdict.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Textarea
              value={reviewBody}
              placeholder={reviewEvent === "approve" ? "Optional summary" : "Summary (Markdown works)"}
              className="min-h-24 text-sm"
              onChange={(event) => setReviewBody(event.target.value)}
            />
            <RadioRows options={REVIEW_EVENTS} value={reviewEvent} onChange={setReviewEvent} />
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReviewOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={reviewEvent === "request_changes" ? "destructive" : "default"}
              disabled={busy || (reviewEvent !== "approve" && !reviewBody.trim())}
              onClick={async () => {
                const ok = await perform({ kind: "review", event: reviewEvent, body: reviewBody }, refreshAll);
                if (ok) {
                  setReviewOpen(false);
                  setReviewBody("");
                }
              }}
            >
              {pending === "review" ? <Spinner className="size-3.5" /> : null}
              Submit review
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Merge #{pr.number}</DialogTitle>
            <DialogDescription>
              Into <code className="font-mono">{pr.baseRef}</code> on GitHub. Your local checkout is
              left as it is.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <RadioRows options={MERGE_METHODS} value={mergeMethod} onChange={setMergeMethod} />
            {pr.isCrossRepository ? null : (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <Checkbox checked={deleteBranch} onCheckedChange={(checked) => setDeleteBranch(checked === true)} />
                Delete <code className="font-mono text-xs">{pr.headRef}</code> on GitHub afterwards
              </label>
            )}
            {pr.checks === "failing" || pr.checks === "pending" ? (
              <p className="rounded-md bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
                {pr.checks === "failing" ? "Some checks are failing." : "Checks are still running."}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMergeOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                const ok = await perform(
                  { kind: "merge", method: mergeMethod, deleteBranch: deleteBranch && !pr.isCrossRepository },
                  refreshAll,
                );
                if (ok) setMergeOpen(false);
              }}
            >
              {pending === "merge" ? <Spinner className="size-3.5" /> : <GitMergeIcon />}
              {MERGE_METHODS.find((m) => m.value === mergeMethod)?.label}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Close #{pr.number}?</DialogTitle>
            <DialogDescription>It can be reopened later. The branch stays.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCloseOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                const ok = await perform({ kind: "close" }, refreshAll);
                if (ok) setCloseOpen(false);
              }}
            >
              {pending === "close" ? <Spinner className="size-3.5" /> : null}
              Close pull request
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
