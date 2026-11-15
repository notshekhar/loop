import type { VcsStatusResult } from "@loop/contracts";
import { useState } from "react";

export type WorkingTreeFile = VcsStatusResult["workingTree"]["files"][number];

export interface CommitRequest {
  readonly commitMessage: string;
  /** Present only when some files were excluded; absent means commit everything. */
  readonly filePaths?: string[];
}

/** Commit dialog state: open flag, message and which changed files are left out. */
export function useCommitDialogState(allFiles: ReadonlyArray<WorkingTreeFile>) {
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const closeCommitDialog = () => {
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
  };
  const openCommitDialog = () => {
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setIsCommitDialogOpen(true);
  };
  const toggleAllFiles = () => {
    setExcludedFiles(allSelected ? new Set(allFiles.map((f) => f.path)) : new Set());
  };
  const toggleFile = (filePath: string) => {
    setExcludedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };
  /** Closes the dialog and hands back what to commit, or null if it wasn't open. */
  const takeCommitRequest = (): CommitRequest | null => {
    if (!isCommitDialogOpen) return null;
    const commitMessage = dialogCommitMessage.trim();
    closeCommitDialog();
    return {
      commitMessage,
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    };
  };

  return {
    isCommitDialogOpen,
    dialogCommitMessage,
    setDialogCommitMessage,
    excludedFiles,
    isEditingFiles,
    setIsEditingFiles,
    selectedFiles,
    allSelected,
    noneSelected,
    closeCommitDialog,
    openCommitDialog,
    toggleAllFiles,
    toggleFile,
    takeCommitRequest,
  };
}

export type CommitDialogState = ReturnType<typeof useCommitDialogState>;
