import type { ScopedThreadRef } from "@loop/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { RefObject } from "react";
import { cn } from "~/lib/utils";
import type { DraftId } from "../../composerDraftStore";
import { DIFF_PANEL_UNSAFE_CSS } from "../../lib/diffPanelCss";
import {
  getDiffCollapseIconClassName,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { type GitStatus, loopGit } from "../../loop/transport";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "../diffs/AnnotatableCodeView";
import { DiscardFileButton } from "../scm/DiscardFileButton";
import { hasIndexView } from "../scm/scmGroups";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DiffCodeViewFile } from "./useDiffFiles";
import type { DiffRenderMode } from "./useDiffViewOptions";

type DiffThemeType = "light" | "dark";

export interface DiffFilesViewProps {
  readonly codeViewRef: RefObject<AnnotatableCodeViewHandle | null>;
  /** Remounts the viewer when the section changes, so scroll and comments start fresh. */
  readonly codeViewKey: string;
  readonly files: ReadonlyArray<DiffCodeViewFile>;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly activeCwd: string | undefined;
  readonly isWorkingTree: boolean;
  readonly scmStatus: GitStatus | null;
  readonly onDiscarded: (next: GitStatus) => void;
  readonly onToggleFile: (fileKey: string) => void;
  readonly onOpenFile: (filePath: string) => void;
  readonly diffRenderMode: DiffRenderMode;
  readonly wordWrap: boolean;
  readonly resolvedTheme: DiffThemeType;
}

/** The patch as file rows; clicking a file's title opens that file. */
export function DiffFilesView(props: DiffFilesViewProps) {
  const { activeCwd, scmStatus, onOpenFile, onToggleFile } = props;
  return (
    <div
      className="min-h-0 flex-1"
      onClickCapture={(event) => {
        const composedPath = event.nativeEvent.composedPath?.() ?? [];
        const title = composedPath.find(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node.hasAttribute("data-title"),
        );
        const filePath = title?.textContent?.trim();
        if (filePath) onOpenFile(filePath);
      }}
    >
      <AnnotatableCodeView
        viewerRef={props.codeViewRef}
        key={props.codeViewKey}
        className="diff-render-surface h-full min-h-0 overflow-auto"
        files={props.files}
        /**
         * Discard, on the file's own header.
         *
         * The source-control sidebar has this too, but reverting one
         * file is the commonest thing to want while reading a patch
         * and opening a second surface to do it is a detour. Only
         * where it can mean something: a working-tree scope in a real
         * repository, never over a historical turn diff.
         */
        {...(activeCwd != null &&
        props.isWorkingTree &&
        hasIndexView(scmStatus) &&
        typeof loopGit()?.discard === "function"
          ? {
              renderHeaderMetadata: (fileDiff: { name: string }) => (
                <DiscardFileButton
                  cwd={activeCwd}
                  path={fileDiff.name}
                  status={scmStatus}
                  onDiscarded={props.onDiscarded}
                />
              ),
            }
          : {})}
        sectionId={props.sectionId}
        sectionTitle={props.sectionTitle}
        composerDraftTarget={props.composerDraftTarget}
        renderHeaderPrefix={(fileDiff, fileKey, collapsed) => (
          <DiffFileCollapseButton
            fileDiff={fileDiff}
            collapsed={collapsed}
            onToggle={() => onToggleFile(fileKey)}
          />
        )}
        options={{
          diffStyle: props.diffRenderMode === "split" ? "split" : "unified",
          lineDiffType: "none",
          overflow: props.wordWrap ? "wrap" : "scroll",
          theme: resolveDiffThemeName(props.resolvedTheme),
          themeType: props.resolvedTheme as DiffThemeType,
          unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
          stickyHeaders: true,
          itemMetrics: { diffHeaderHeight: 33 },
          layout: { paddingTop: 0, paddingBottom: 8, gap: 8 },
        }}
      />
    </div>
  );
}

function DiffFileCollapseButton({
  fileDiff,
  collapsed,
  onToggle,
}: {
  readonly fileDiff: FileDiffMetadata;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  const filePath = resolveFileDiffPath(fileDiff);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
              getDiffCollapseIconClassName(fileDiff),
            )}
            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
            aria-expanded={!collapsed}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          />
        }
      >
        {collapsed ? <ChevronRightIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
    </Tooltip>
  );
}
