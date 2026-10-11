import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewProps } from "@pierre/diffs/react";
import { useDiffWorkers } from "../diffWorkerDemand";
import type { ScopedThreadRef } from "@loop/contracts";
import { useCallback, useMemo, useState, type ReactNode, type Ref } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { fnv1a32 } from "~/lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { LocalCommentAnnotation } from "../files/LocalCommentAnnotation";
import { nextFileCommentId } from "../files/fileCommentAnnotations";

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup>;
const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

function annotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = annotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    collapsed: boolean;
  }>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: NonNullable<CodeViewProps<DiffCommentAnnotationGroup>["options"]>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
  /**
   * The right-hand end of a file's header row, where per-file actions belong.
   *
   * Optional, because the review pane has nothing to put there; the diff panel
   * uses it for discard, so a change can be thrown away without first opening
   * the source-control sidebar.
   */
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata, fileKey: string) => ReactNode;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  files,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  viewerRef,
  className,
  renderHeaderPrefix,
  renderHeaderMetadata,
}: AnnotatableCodeViewProps) {
  const diffsReady = useDiffWorkers();
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<{
    fileKey: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);

  const filesByKey = useMemo(() => new Map(files.map((file) => [file.fileKey, file])), [files]);
  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(
    () =>
      files.map(({ fileDiff, filePath, fileKey, collapsed }) => {
        const persisted = reviewComments
          .filter(
            (comment) =>
              comment.sectionId === sectionId &&
              comment.filePath === filePath &&
              (comment.fenceLanguage ?? "diff") === "diff",
          )
          .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
            const range = restoreDiffReviewCommentRange(fileDiff, comment);
            if (!range) return annotations;
            return appendAnnotationEntry(annotations, range, {
              id: comment.id,
              kind: "comment",
              range,
              rangeLabel: comment.rangeLabel,
              text: comment.text,
            });
          }, []);
        const annotations =
          draft?.fileKey === fileKey ? [...persisted, draft.annotation] : persisted;
        return {
          id: fileKey,
          type: "diff",
          fileDiff,
          annotations,
          collapsed,
          // The file's own identity leads the hash. Item ids are the file
          // PATH, so they survive a re-read of the same diff (which is what
          // keeps scroll and collapse state across the panel's refreshes) —
          // and CodeView only re-renders a reused record when its version
          // moves. Without the content in here, a refreshed patch would land
          // on the same id at the same version and never repaint.
          version: fnv1a32(
            `${fileDiff.cacheKey ?? ""}:${collapsed ? "1" : "0"}:${annotations
              .flatMap((annotation) =>
                annotation.metadata.entries.map(
                  (entry) => `${entry.id}:${entry.rangeLabel}:${entry.text}`,
                ),
              )
              .join(":")}`,
          ),
        };
      }),
    [draft, files, reviewComments, sectionId],
  );

  const removeEntry = useCallback(
    (entryId: string) => {
      setSelectedLines(null);
      if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
        setDraft(null);
      } else {
        removeReviewComment(composerDraftTarget, entryId);
      }
    },
    [composerDraftTarget, draft, removeReviewComment],
  );

  const submitEntry = useCallback(
    (entryId: string, text: string) => {
      const entry = draft?.annotation.metadata.entries.find(
        (candidate) => candidate.id === entryId,
      );
      const file = draft ? filesByKey.get(draft.fileKey) : undefined;
      if (!entry || !file) return;
      const comment = buildDiffReviewComment({
        id: entry.id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range: entry.range,
        text,
      });
      if (comment) addReviewComment(composerDraftTarget, comment);
      setSelectedLines(null);
      setDraft(null);
    },
    [addReviewComment, composerDraftTarget, draft, filesByKey, sectionId, sectionTitle],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: DiffSelectionContext) => {
      if (!range) return;
      const item = context.item;
      if (item.type !== "diff") return;
      const file = filesByKey.get(item.id);
      if (!file) return;
      const id = nextFileCommentId();
      const comment = buildDiffReviewComment({
        id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range,
        text: "",
      });
      if (!comment) return;
      setDraft({
        fileKey: item.id,
        annotation: {
          side: annotationSide(range),
          lineNumber: range.end,
          metadata: {
            entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
          },
        },
      });
    },
    [filesByKey, sectionId, sectionTitle],
  );

  /**
   * The gutter "+" button, which is the only way most people ever start a
   * comment.
   *
   * It has to be handled even though the selection callbacks already keep
   * `selectedLines` in step: `InteractionManager` routes a pointerdown on the
   * utility button to its gutter-selection session ONLY when
   * `onGutterUtilityClick` is set, and otherwise falls through to ordinary
   * line selection — which explicitly refuses any path through the utility
   * button (`excludeUtility`). So without this the "+" appeared on hover,
   * accepted the click, and did nothing at all, while dragging the line
   * numbers still opened a comment. The file view has always passed one,
   * which is why commenting worked there and not here.
   */
  const selectGutterRange = useCallback(
    (range: SelectedLineRange | null, context: DiffSelectionContext) => {
      setSelectedLines(range === null ? null : { id: context.item.id, range });
    },
    [],
  );

  const hasOpenComment = draft !== null;
  if (!diffsReady) return null;
  return (
    <CodeView<DiffCommentAnnotationGroup>
      {...(viewerRef ? { ref: viewerRef } : {})}
      {...(className ? { className } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={setSelectedLines}
      options={{
        ...options,
        enableGutterUtility: !hasOpenComment,
        enableLineSelection: !hasOpenComment,
        onGutterUtilityClick: selectGutterRange,
        onLineSelectionEnd: beginComment,
      }}
      renderHeaderPrefix={(item) =>
        item.type === "diff"
          ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
          : null
      }
      renderHeaderMetadata={(item) =>
        item.type === "diff" && renderHeaderMetadata
          ? renderHeaderMetadata(item.fileDiff, item.id)
          : null
      }
      renderAnnotation={(annotation) => (
        <div className="py-1">
          {annotation.metadata.entries.map((entry) => (
            <LocalCommentAnnotation
              key={entry.id}
              kind={entry.kind}
              rangeLabel={entry.rangeLabel}
              text={entry.text}
              onCancel={() => removeEntry(entry.id)}
              onComment={(text) => submitEntry(entry.id, text)}
              onDelete={() => removeEntry(entry.id)}
            />
          ))}
        </div>
      )}
    />
  );
}
