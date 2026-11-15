import type { ComponentProps, ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { RenderablePatch } from "../../lib/diffRendering";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { WorkspaceRepositoryList } from "../diffs/WorkspaceRepositoryList";
import { DiffFilesView, type DiffFilesViewProps } from "./DiffFilesView";

type WorkspaceRepositories = ComponentProps<typeof WorkspaceRepositoryList>["repositories"];

interface DiffPanelContentProps {
  readonly activeCwd: string | undefined;
  readonly showingRepositoryList: boolean;
  readonly workspaceRepositories: WorkspaceRepositories | null;
  readonly onOpenRepository: (repository: string) => void;
  readonly isGitRepo: boolean;
  readonly hasNoCompletedTurns: boolean;
  readonly viewport: DiffPatchViewportProps;
}

/** The panel body: why there is nothing to show, the repository list, or the patch. */
export function DiffPanelContent({
  activeCwd,
  showingRepositoryList,
  workspaceRepositories,
  onOpenRepository,
  isGitRepo,
  hasNoCompletedTurns,
  viewport,
}: DiffPanelContentProps) {
  return !activeCwd ? (
    <PanelNotice>Select a thread to inspect turn diffs.</PanelNotice>
  ) : showingRepositoryList ? (
    <WorkspaceRepositoryList
      repositories={workspaceRepositories ?? []}
      onOpen={onOpenRepository}
    />
  ) : !isGitRepo ? (
    <PanelNotice>
      Turn diffs are unavailable because this project is not a git repository.
    </PanelNotice>
  ) : hasNoCompletedTurns ? (
    <PanelNotice>No completed turns yet.</PanelNotice>
  ) : (
    <DiffPatchViewport {...viewport} />
  );
}

function PanelNotice({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
      {children}
    </div>
  );
}

interface DiffPatchViewportProps {
  readonly isSelectedPatchTruncated: boolean;
  readonly selectedPatchError: string | null;
  readonly renderablePatch: RenderablePatch | null;
  readonly isLoadingSelectedPatch: boolean;
  readonly isTurnSelected: boolean;
  readonly hasNoNetChanges: boolean;
  readonly wordWrap: boolean;
  readonly filesView: DiffFilesViewProps;
}

function DiffPatchViewport({
  isSelectedPatchTruncated,
  selectedPatchError,
  renderablePatch,
  isLoadingSelectedPatch,
  isTurnSelected,
  hasNoNetChanges,
  wordWrap,
  filesView,
}: DiffPatchViewportProps) {
  return (
    <div className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {isSelectedPatchTruncated && (
        <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          This diff was truncated because it exceeded the preview limit. The changes shown are
          incomplete.
        </p>
      )}
      {selectedPatchError && !renderablePatch && (
        <div className="px-3">
          <p className="mb-2 text-[11px] text-red-500/80">{selectedPatchError}</p>
        </div>
      )}
      {!renderablePatch ? (
        isLoadingSelectedPatch ? (
          <DiffPanelLoadingState
            label={isTurnSelected ? "Loading checkpoint diff..." : "Loading working tree diff..."}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
            <p>
              {hasNoNetChanges
                ? "No net changes in this selection."
                : "No patch available for this selection."}
            </p>
          </div>
        )
      ) : renderablePatch.kind === "files" ? (
        <DiffFilesView {...filesView} />
      ) : (
        <RawPatchView
          reason={renderablePatch.reason}
          text={renderablePatch.text}
          wordWrap={wordWrap}
        />
      )}
    </div>
  );
}

/** A patch the viewer cannot parse into files, shown as text with the reason. */
function RawPatchView({
  reason,
  text,
  wordWrap,
}: {
  readonly reason: string;
  readonly text: string;
  readonly wordWrap: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground/75">{reason}</p>
        <pre
          className={cn(
            "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
            wordWrap ? "overflow-auto whitespace-pre-wrap wrap-break-word" : "overflow-auto",
          )}
        >
          {text}
        </pre>
      </div>
    </div>
  );
}
