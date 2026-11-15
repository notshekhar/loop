import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import type { CommitDialogState, WorkingTreeFile } from "./useCommitDialogState";

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

interface CommitDialogProps {
  readonly commit: CommitDialogState;
  readonly allFiles: ReadonlyArray<WorkingTreeFile>;
  readonly hasStatus: boolean;
  readonly branchName: string | null | undefined;
  readonly isDefaultRef: boolean;
  readonly onOpenFile: (filePath: string) => void;
  readonly onCommit: () => void;
  readonly onCommitOnNewBranch: () => void;
}

export function CommitDialog(props: CommitDialogProps) {
  const { commit } = props;
  return (
    <Dialog
      open={commit.isCommitDialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          commit.closeCommitDialog();
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-3 rounded-xl bg-zinc-25 p-3 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">Branch</span>
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{props.branchName ?? "(detached HEAD)"}</span>
                {props.isDefaultRef && (
                  <span className="text-right text-warning">Warning: default refName</span>
                )}
              </span>
            </div>
            <CommitFilesSection {...props} />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Commit message (optional)</p>
            <Textarea
              value={commit.dialogCommitMessage}
              onChange={(event) => commit.setDialogCommitMessage(event.target.value)}
              placeholder="Leave empty to auto-generate"
              size="sm"
            />
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" size="sm" onClick={commit.closeCommitDialog}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={commit.noneSelected}
            onClick={props.onCommitOnNewBranch}
          >
            Commit on new refName
          </Button>
          <Button size="sm" disabled={commit.noneSelected} onClick={props.onCommit}>
            Commit
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CommitFilesSection({ commit, allFiles, hasStatus, onOpenFile }: CommitDialogProps) {
  const { allSelected, noneSelected, isEditingFiles, selectedFiles } = commit;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isEditingFiles && allFiles.length > 0 && (
            <Checkbox
              checked={allSelected}
              indeterminate={!allSelected && !noneSelected}
              onCheckedChange={commit.toggleAllFiles}
            />
          )}
          <span className="text-muted-foreground">Files</span>
          {!allSelected && !isEditingFiles && (
            <span className="text-muted-foreground">
              ({selectedFiles.length} of {allFiles.length})
            </span>
          )}
        </div>
        {allFiles.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => commit.setIsEditingFiles((prev) => !prev)}
          >
            {isEditingFiles ? "Done" : "Edit"}
          </Button>
        )}
      </div>
      {!hasStatus || allFiles.length === 0 ? (
        <p className="font-medium">none</p>
      ) : (
        <div className="space-y-2">
          <ScrollArea className="h-44 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
            <div className="space-y-1 p-1">
              {allFiles.map((file) => (
                <CommitFileRow
                  key={file.path}
                  file={file}
                  isExcluded={commit.excludedFiles.has(file.path)}
                  isEditingFiles={isEditingFiles}
                  onToggle={() => commit.toggleFile(file.path)}
                  onOpen={() => onOpenFile(file.path)}
                />
              ))}
            </div>
          </ScrollArea>
          <CommitFileTotals files={selectedFiles} />
        </div>
      )}
    </div>
  );
}

function CommitFileTotals({ files }: { files: ReadonlyArray<WorkingTreeFile> }) {
  return (
    <div className="flex justify-end font-mono">
      <span className="text-success">+{files.reduce((sum, f) => sum + f.insertions, 0)}</span>
      <span className="text-muted-foreground"> / </span>
      <span className="text-destructive">-{files.reduce((sum, f) => sum + f.deletions, 0)}</span>
    </div>
  );
}

function CommitFileRow({
  file,
  isExcluded,
  isEditingFiles,
  onToggle,
  onOpen,
}: {
  file: WorkingTreeFile;
  isExcluded: boolean;
  isEditingFiles: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50">
      {isEditingFiles && <Checkbox checked={!isExcluded} onCheckedChange={onToggle} />}
      <button
        type="button"
        className="flex flex-1 items-center justify-between gap-3 text-left truncate"
        onClick={onOpen}
      >
        <span className={`truncate${isExcluded ? " text-muted-foreground" : ""}`}>{file.path}</span>
        <span className="shrink-0">
          {isExcluded ? (
            <span className="text-muted-foreground">Excluded</span>
          ) : (
            <>
              <span className="text-success">+{file.insertions}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-destructive">-{file.deletions}</span>
            </>
          )}
        </span>
      </button>
    </div>
  );
}
