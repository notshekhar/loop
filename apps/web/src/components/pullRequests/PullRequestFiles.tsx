/**
 * A pull request's Files tab: the changed files on the left with GitHub's own
 * "Viewed" checkboxes, the diff on the right in the same viewer the chat's
 * diff panel uses.
 *
 * Review threads sit on their lines. Select lines (or press the gutter "+")
 * to comment on them; the comment posts straight to GitHub as a single line
 * comment, and replies go into the thread. A viewed file collapses, the way it
 * does on github.com, and opens again with a click on its header.
 */
import type { LoopPullRequestDetail, LoopPullRequestTimelineItem } from "@loop/contracts";
import type {
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { DIFF_PANEL_UNSAFE_CSS } from "../../lib/diffPanelCss";
import {
  fnv1a32,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { cn } from "../../lib/utils";
import { useDiffWorkers } from "../diffWorkerDemand";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";
import { PullRequestCommentBox, PullRequestThread } from "./PullRequestConversation";
import { lineCommentAnchor, splitPath, threadsByLine, type DiffSide } from "./pullRequestPresentation";
import { usePullRequestDiff, type PullRequestScope } from "./usePullRequests";

type ThreadItem = Extract<LoopPullRequestTimelineItem, { kind: "thread" }>;

type Annotation =
  | { readonly kind: "threads"; readonly threads: ThreadItem[] }
  | { readonly kind: "draft"; readonly range: SelectedLineRange; readonly path: string };

function sideOf(range: SelectedLineRange): DiffSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

export function PullRequestFiles(props: {
  readonly scope: PullRequestScope;
  readonly pr: LoopPullRequestDetail;
  readonly timeline: ReadonlyArray<LoopPullRequestTimelineItem>;
  readonly busy: boolean;
  readonly onComment: (input: {
    path: string;
    line: number;
    startLine?: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }) => Promise<boolean>;
  readonly onReply: (commentId: number, body: string) => Promise<boolean>;
  readonly onToggleViewed: (path: string, viewed: boolean) => void;
  readonly viewedOverrides: ReadonlyMap<string, boolean>;
}) {
  const { pr, scope, timeline, viewedOverrides } = props;
  const diff = usePullRequestDiff(scope, pr.number);
  const { resolvedTheme } = useTheme();
  const diffsReady = useDiffWorkers();
  const viewerRef = useRef<CodeViewHandle<Annotation>>(null);
  const [selectedLines, setSelectedLines] = useState<{ id: string; range: SelectedLineRange } | null>(
    null,
  );
  const [draft, setDraft] = useState<{ fileKey: string; range: SelectedLineRange } | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  const isViewed = useCallback(
    (path: string) =>
      viewedOverrides.get(path) ?? pr.files.find((file) => file.path === path)?.viewed === true,
    [pr.files, viewedOverrides],
  );

  const renderable = useMemo(
    () => getRenderablePatch(diff.data?.patch, `pull-request:${pr.number}:${resolvedTheme}`),
    [diff.data?.patch, pr.number, resolvedTheme],
  );
  const files = useMemo(() => {
    if (!renderable || renderable.kind !== "files") return [];
    return renderable.files.map((fileDiff: FileDiffMetadata) => ({
      fileDiff,
      path: resolveFileDiffPath(fileDiff),
    }));
  }, [renderable]);

  const collapsedOf = useCallback(
    (path: string) => closed.has(path) || (isViewed(path) && !opened.has(path)),
    [closed, isViewed, opened],
  );

  const items = useMemo<CodeViewDiffItem<Annotation>[]>(
    () =>
      files.map(({ fileDiff, path }) => {
        const annotations: DiffLineAnnotation<Annotation>[] = threadsByLine(timeline, path).map(
          (group) => ({
            side: group.side,
            lineNumber: group.lineNumber,
            metadata: { kind: "threads", threads: group.threads },
          }),
        );
        if (draft?.fileKey === path) {
          annotations.push({
            side: sideOf(draft.range),
            lineNumber: draft.range.end,
            metadata: { kind: "draft", range: draft.range, path },
          });
        }
        const collapsed = collapsedOf(path);
        return {
          id: path,
          type: "diff",
          fileDiff,
          annotations,
          collapsed,
          version: fnv1a32(
            `${fileDiff.cacheKey ?? ""}:${collapsed ? 1 : 0}:${annotations
              .map((a) =>
                a.metadata.kind === "draft"
                  ? `d${a.lineNumber}`
                  : a.metadata.threads.map((t) => `${t.id}:${t.comments.length}`).join(","),
              )
              .join("|")}`,
          ),
        };
      }),
    [collapsedOf, draft, files, timeline],
  );

  const toggleCollapsed = useCallback(
    (path: string) => {
      const collapsed = collapsedOf(path);
      setOpened((prev) => {
        const next = new Set(prev);
        if (collapsed) next.add(path);
        else next.delete(path);
        return next;
      });
      setClosed((prev) => {
        const next = new Set(prev);
        if (collapsed) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [collapsedOf],
  );

  const reveal = useCallback(
    (path: string) => {
      if (collapsedOf(path)) toggleCollapsed(path);
      requestAnimationFrame(() => viewerRef.current?.scrollTo({ type: "item", id: path, align: "start" }));
    },
    [collapsedOf, toggleCollapsed],
  );

  // A new diff (another PR, or a refresh after pushing) starts clean.
  useEffect(() => {
    setDraft(null);
    setSelectedLines(null);
  }, [pr.number, pr.headSha]);

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: { item: CodeViewItem<Annotation> }) => {
      if (!range || context.item.type !== "diff") return;
      setDraft({ fileKey: context.item.id, range });
    },
    [],
  );

  const viewedCount = pr.files.filter((file) => isViewed(file.path)).length;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border/70">
        <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
          <span>{pr.files.length} files</span>
          <span className="tabular-nums">
            {viewedCount}/{pr.files.length} viewed
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {pr.files.map((file) => {
            const { name, folder } = splitPath(file.path);
            const viewed = isViewed(file.path);
            return (
              <div
                key={file.path}
                className="group flex items-center gap-2 px-2 py-1 hover:bg-accent/50"
                title={file.path}
              >
                <Checkbox
                  aria-label={viewed ? `Mark ${file.path} not viewed` : `Mark ${file.path} viewed`}
                  checked={viewed}
                  disabled={file.viewed === undefined || file.viewed === null}
                  onCheckedChange={(checked) => props.onToggleViewed(file.path, checked === true)}
                />
                <button
                  type="button"
                  onClick={() => reveal(file.path)}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                >
                  <span
                    className={cn(
                      "block truncate font-mono text-xs",
                      viewed ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {name}
                  </span>
                  {folder ? (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                      {folder}
                    </span>
                  ) : null}
                </button>
                <span className="shrink-0 font-mono text-[10px] tabular-nums">
                  <span className="text-success-foreground">+{file.additions}</span>{" "}
                  <span className="text-destructive-foreground">−{file.deletions}</span>
                </span>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {diff.error && !diff.data ? (
          <p className="p-4 text-sm text-destructive-foreground">{diff.error}</p>
        ) : !diff.data || !diffsReady ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading changes…
          </div>
        ) : !renderable ? (
          <p className="p-4 text-sm text-muted-foreground">This pull request changes no text.</p>
        ) : renderable.kind === "raw" ? (
          <pre className="m-3 overflow-auto rounded-md border border-border p-3 font-mono text-[11px]">
            {renderable.text}
          </pre>
        ) : (
          <>
            {diff.data.truncated ? (
              <p className="border-b border-border/70 px-4 py-2 text-xs text-muted-foreground">
                This diff is too large to show in full — the rest is on GitHub.
              </p>
            ) : null}
            <CodeView<Annotation>
              ref={viewerRef}
              className="diff-render-surface h-full min-h-0 overflow-auto"
              items={items}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              options={{
                diffStyle: "unified",
                lineDiffType: "none",
                overflow: "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                themeType: resolvedTheme,
                unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                stickyHeaders: true,
                itemMetrics: { diffHeaderHeight: 33 },
                layout: { paddingTop: 0, paddingBottom: 8, gap: 8 },
                enableGutterUtility: draft === null && !props.busy,
                enableLineSelection: draft === null && !props.busy,
                onGutterUtilityClick: (range, context) =>
                  setSelectedLines(range === null ? null : { id: context.item.id, range }),
                onLineSelectionEnd: beginComment,
              }}
              renderHeaderPrefix={(item) =>
                item.type === "diff" ? (
                  <button
                    type="button"
                    aria-label={item.collapsed ? `Expand ${item.id}` : `Collapse ${item.id}`}
                    className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-foreground/10"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleCollapsed(item.id);
                    }}
                  >
                    {item.collapsed ? (
                      <ChevronRightIcon className="size-4" />
                    ) : (
                      <ChevronDownIcon className="size-4" />
                    )}
                  </button>
                ) : null
              }
              renderHeaderMetadata={(item) =>
                item.type === "diff" ? (
                  <label
                    className="mr-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Checkbox
                      checked={isViewed(item.id)}
                      disabled={!pr.files.some((f) => f.path === item.id && typeof f.viewed === "boolean")}
                      onCheckedChange={(checked) => props.onToggleViewed(item.id, checked === true)}
                    />
                    Viewed
                  </label>
                ) : null
              }
              renderAnnotation={(annotation) => {
                const meta = annotation.metadata;
                if (meta.kind === "threads") {
                  return (
                    <div className="space-y-2 px-3 py-2 font-sans select-text [-webkit-user-select:text]">
                      {meta.threads.map((thread) => (
                        <PullRequestThread
                          key={thread.id}
                          thread={thread}
                          compact
                          busy={props.busy}
                          onReply={(body) => props.onReply(thread.id, body)}
                        />
                      ))}
                    </div>
                  );
                }
                const anchor = lineCommentAnchor(meta.range);
                return (
                  <div
                    className="px-3 py-2 font-sans select-text [-webkit-user-select:text]"
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <PullRequestCommentBox
                      autoFocus
                      label={
                        anchor.startLine !== undefined
                          ? `Comment on lines ${anchor.startLine}–${anchor.line}`
                          : `Comment on line ${anchor.line}`
                      }
                      submitLabel="Comment"
                      busy={props.busy}
                      onCancel={() => {
                        setDraft(null);
                        setSelectedLines(null);
                      }}
                      onSubmit={async (body) => {
                        const ok = await props.onComment({ path: meta.path, ...anchor, body });
                        if (ok) {
                          setDraft(null);
                          setSelectedLines(null);
                        }
                        return ok;
                      }}
                    />
                  </div>
                );
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
