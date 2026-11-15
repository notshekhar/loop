import { type Dispatch, type SetStateAction, useCallback, useState } from "react";
import { toggleAllDiffFiles } from "../../lib/diffCollapse";

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

type SetCollapsedDiffFiles = Dispatch<SetStateAction<CollapsedDiffFilesState>>;

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

/** Which files are collapsed, remembered only for the section they were collapsed in. */
export function useCollapsedDiffFiles(collapseScopeKey: string | null) {
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  const collapsedDiffFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  return { collapsedDiffFileKeys, setCollapsedDiffFiles };
}

/** Collapse one file, or every file at once. */
export function useDiffFileCollapseActions(
  setCollapsedDiffFiles: SetCollapsedDiffFiles,
  collapseScopeKey: string | null,
  diffFileKeys: ReadonlyArray<string>,
) {
  const toggleDiffFileCollapsed = useCallback(
    (fileKey: string) => {
      setCollapsedDiffFiles((current) => {
        const next = new Set(current.scopeKey === collapseScopeKey ? current.fileKeys : []);
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    },
    [collapseScopeKey, setCollapsedDiffFiles],
  );

  const toggleDiffFileCollapse = useCallback(() => {
    setCollapsedDiffFiles((current) => {
      const currentKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : EMPTY_COLLAPSED_DIFF_FILE_KEYS;

      return {
        scopeKey: collapseScopeKey,
        fileKeys: toggleAllDiffFiles(diffFileKeys, currentKeys),
      };
    });
  }, [collapseScopeKey, diffFileKeys, setCollapsedDiffFiles]);
  return { toggleDiffFileCollapsed, toggleDiffFileCollapse };
}
