import { type RefObject, useEffect, useMemo } from "react";
import { areAllDiffFilesCollapsed } from "../../lib/diffCollapse";
import {
  buildFileDiffRenderKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import type { AnnotatableCodeViewHandle } from "../diffs/AnnotatableCodeView";

export type DiffCodeViewFile = ReturnType<typeof useDiffFiles>["codeViewFiles"][number];

/** The patch parsed into the sorted, keyed file rows the code view renders. */
export function useDiffFiles(
  selectedPatch: string | undefined,
  patchCacheTheme: string,
  isWorkingTree: boolean,
  collapsedDiffFileKeys: ReadonlySet<string>,
) {
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(selectedPatch, `diff-panel:${patchCacheTheme}`, {
        compactPartialHunkOffsets: isWorkingTree,
      }),
    [patchCacheTheme, selectedPatch, isWorkingTree],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const codeViewFiles = useMemo(() => {
    // Keys are paths now, which CodeView indexes by, so a patch that somehow
    // names the same path twice would have the second file overwrite the
    // first. Disambiguating keeps both rows; it costs the repeat its stable
    // identity, which is the right trade for something that should not happen.
    const seen = new Map<string, number>();
    return renderableFiles.map((fileDiff) => {
      const baseKey = buildFileDiffRenderKey(fileDiff);
      const repeats = seen.get(baseKey) ?? 0;
      seen.set(baseKey, repeats + 1);
      const fileKey = repeats === 0 ? baseKey : `${baseKey}#${repeats}`;
      return {
        fileDiff,
        filePath: resolveFileDiffPath(fileDiff),
        fileKey,
        collapsed: collapsedDiffFileKeys.has(fileKey),
      };
    });
  }, [collapsedDiffFileKeys, renderableFiles]);
  const diffFileKeys = useMemo(() => codeViewFiles.map((file) => file.fileKey), [codeViewFiles]);
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const diffLineStat = useMemo(() => getDiffLineStat(renderableFiles), [renderableFiles]);
  return { renderablePatch, codeViewFiles, diffFileKeys, allDiffFilesCollapsed, diffLineStat };
}

/** Scrolls the code view to the file a selection asked to reveal. */
export function useRevealSelectedFile(
  codeViewRef: RefObject<AnnotatableCodeViewHandle | null>,
  codeViewFiles: ReadonlyArray<DiffCodeViewFile>,
  selectedFilePath: string | null,
  selectedFileRevealRequestId: number,
) {
  useEffect(() => {
    if (!selectedFilePath) return;
    const file = codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath);
    if (!file) return;
    codeViewRef.current?.scrollTo({ type: "item", id: file.fileKey, align: "start" });
  }, [codeViewFiles, codeViewRef, selectedFilePath, selectedFileRevealRequestId]);
}
