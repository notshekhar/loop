import type { ScopedThreadRef } from "@loop/contracts";
import {
  ChevronLeftIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import type { DraftId } from "../../composerDraftStore";
import type { DiffLineStat } from "../../lib/diffRendering";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import GitActionsControl from "../GitActionsControl";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DiffViewOptions } from "./useDiffViewOptions";

interface DiffPanelHeaderNavProps {
  readonly showingRepositoryList: boolean;
  readonly showGitActions: boolean;
  readonly activeCwd: string | undefined;
  readonly diffSelectionRef: ScopedThreadRef | null;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly openRepository: string | null;
  readonly isPinnedRepository: boolean;
  readonly onBackToRepositories: () => void;
}

/** The header's left side: what is on screen, the git actions, and the way back. */
export function DiffPanelHeaderNav({
  showingRepositoryList,
  showGitActions,
  activeCwd,
  diffSelectionRef,
  composerDraftTarget,
  openRepository,
  isPinnedRepository,
  onBackToRepositories,
}: DiffPanelHeaderNavProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
      {showingRepositoryList ? (
        // Nothing here is per-scope yet: the list is the whole view, and a
        // "working tree / branch changes" picker over it would be a choice
        // the list cannot honour.
        <span className="shrink-0 text-xs font-medium text-foreground">Repositories</span>
      ) : null}
      {/*
        The scope picker is gone for now.

        It offered "working tree", "branch changes" and a turn to compare
        against, and turn-scoped diffs are not how this project's changes are
        followed — so the picker mostly offered ways to end up looking at
        something other than the work in progress. The panel shows the working
        tree; see FOLLOWUPS.md for bringing the other scopes back deliberately.
      */}
      {activeCwd != null && showGitActions ? (
        <>
          {/* The same control the chat header carries, so committing has one
              implementation and one set of behaviours rather than two. */}
          <GitActionsControl
            gitCwd={activeCwd}
            /**
             * The same inputs the chat header gives it.
             *
             * A bare route ref is not enough: on a draft route there is no
             * thread yet, and the control reads the draft to know which
             * files a commit would cover — without it the menu comes up
             * with none of its actions offered.
             */
            activeThreadRef={diffSelectionRef}
            {...(typeof composerDraftTarget === "string" ? { draftId: composerDraftTarget } : {})}
          />
          <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
        </>
      ) : null}
      {openRepository !== null && !isPinnedRepository ? (
        <button
          type="button"
          onClick={onBackToRepositories}
          className="inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-md bg-muted/70 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Back to all repositories (currently ${openRepository})`}
        >
          <ChevronLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{openRepository}</span>
        </button>
      ) : null}
    </div>
  );
}

interface DiffPanelToolbarProps {
  readonly fileCount: number;
  readonly diffLineStat: DiffLineStat;
  readonly allDiffFilesCollapsed: boolean;
  readonly onToggleAllFiles: () => void;
  readonly viewOptions: DiffViewOptions;
}

/** The header's right side: the change count and the view toggles. */
export function DiffPanelToolbar({
  fileCount,
  diffLineStat,
  allDiffFilesCollapsed,
  onToggleAllFiles,
  viewOptions,
}: DiffPanelToolbarProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {fileCount > 0 && (
        <DiffStatLabel
          additions={diffLineStat.additions}
          deletions={diffLineStat.deletions}
          className="mr-1 text-[11px]"
          layout="inline"
        />
      )}
      {fileCount > 0 && (
        <CollapseAllFilesButton
          allDiffFilesCollapsed={allDiffFilesCollapsed}
          onToggleAllFiles={onToggleAllFiles}
        />
      )}
      <DiffRenderModeToggle viewOptions={viewOptions} />
      <DiffLineToggles viewOptions={viewOptions} />
    </div>
  );
}

function CollapseAllFilesButton({
  allDiffFilesCollapsed,
  onToggleAllFiles,
}: Pick<DiffPanelToolbarProps, "allDiffFilesCollapsed" | "onToggleAllFiles">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            onClick={onToggleAllFiles}
          />
        }
      >
        {allDiffFilesCollapsed ? (
          <ChevronsUpDownIcon className="size-3" />
        ) : (
          <ChevronsDownUpIcon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
      </TooltipPopup>
    </Tooltip>
  );
}

function DiffRenderModeToggle({ viewOptions }: { readonly viewOptions: DiffViewOptions }) {
  const { diffRenderMode, setDiffRenderMode } = viewOptions;
  return (
    <ToggleGroup
      className="shrink-0"
      variant="outline"
      size="xs"
      value={[diffRenderMode]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "stacked" || next === "split") {
          setDiffRenderMode(next);
        }
      }}
    >
      <Toggle aria-label="Stacked diff view" value="stacked">
        <Rows3Icon className="size-3" />
      </Toggle>
      <Toggle aria-label="Split diff view" value="split">
        <Columns2Icon className="size-3" />
      </Toggle>
    </ToggleGroup>
  );
}

/** Line wrapping and whitespace: two siblings, so the toolbar's DOM order is unchanged. */
function DiffLineToggles({ viewOptions }: { readonly viewOptions: DiffViewOptions }) {
  const { wordWrap, setWordWrap, diffIgnoreWhitespace, setDiffIgnoreWhitespace } = viewOptions;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
              variant="outline"
              size="xs"
              pressed={wordWrap}
              onPressedChange={(pressed) => {
                setWordWrap(Boolean(pressed));
              }}
            />
          }
        >
          <TextWrapIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={
                diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
              }
              variant="outline"
              size="xs"
              pressed={diffIgnoreWhitespace}
              onPressedChange={(pressed) => {
                setDiffIgnoreWhitespace(Boolean(pressed));
              }}
            />
          }
        >
          <PilcrowIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
