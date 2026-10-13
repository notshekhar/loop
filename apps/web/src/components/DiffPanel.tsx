import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import { safeErrorLogAttributes } from "@loop/runtime/errors";
import type { ScopedThreadRef, TurnId } from "@loop/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useDocumentVisible } from "../hooks/useDocumentVisible";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useProject, useThread } from "../state/entities";
import { scopeThreadRef } from "@loop/runtime/environment";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings } from "../hooks/useSettings";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { type GitStatus, loopGit } from "../loop/transport";
import GitActionsControl from "./GitActionsControl";
import { DiscardFileButton } from "./scm/DiscardFileButton";
import { hasIndexView } from "./scm/scmGroups";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { DIFF_PANEL_UNSAFE_CSS } from "../lib/diffPanelCss";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { useRightPanelStore } from "../rightPanelStore";
import { WorkspaceRepositoryList } from "./diffs/WorkspaceRepositoryList";
import { Button } from "./ui/button";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

/**
 * How long the panel waits after something moves before re-reading the diff.
 *
 * A turn that writes five files ticks five times, and each refresh is a `git
 * diff` over the whole tree — so the ticks are collapsed into one read. Short
 * enough that a single edit still lands while the user is looking at it.
 */
const DIFF_REFRESH_DEBOUNCE_MS = 400;

/**
 * How often the panel re-reads the diff on its own while a turn is running.
 *
 * The event-driven triggers below are both coarser than a tool call. The
 * thread's `updatedAt` is loop's PERSISTED session timestamp, and loop writes
 * a step's messages in one transaction after the step ends
 * (`packages/core/src/agent/turn.ts`) — so an `edit` or `write` in the middle
 * of a step is invisible to it until the model has finished thinking about the
 * result, which on a long step is a minute of watching a diff that does not
 * move. Git status is content-derived but only polls every five seconds, and
 * only notices changes that move a file's line counts.
 *
 * So while the agent is working, the panel just looks. It is one `git diff`
 * against a tree that is already warm in the page cache, and it stops the
 * moment the turn does.
 */
const DIFF_REFRESH_WHILE_RUNNING_MS = 1_500;

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  initialGitScope: "branch" | "unstaged";
  /**
   * The repository this panel is pinned to, when it was opened as its own tab
   * from a folder of repositories.
   */
  repositoryPath?: string;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  initialGitScope: initialGitScopeProp,
  repositoryPath: pinnedRepository,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [initialGitScope] = useState(initialGitScopeProp);
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  /**
   * Which nested repository is open, when the project is a folder of them.
   *
   * Null means the list. Selecting one re-points every git query at that
   * repository's own path, so from there down this is an ordinary single-repo
   * diff — same base-ref picker, same scopes, same everything.
   */
  // A pinned tab IS that repository: there is nothing to navigate back to.
  const [openRepository, setOpenRepository] = useState<string | null>(pinnedRepository ?? null);
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThread(routeThreadRef);
  /**
   * A thread that has not been sent yet still belongs to a folder.
   *
   * Turn diffs need a server thread — there are no turns before one exists —
   * but the working tree does not: it only needs a cwd. Reading that from the
   * draft (the same fallback the terminal drawer uses) is what lets the panel
   * open on a brand new thread, where it used to say "select a thread" over a
   * folder full of uncommitted changes.
   */
  const draftThread = useComposerDraftStore((store) =>
    // A draft route has no thread ref at all — the draft is keyed by its own
    // id, which is exactly what `composerDraftTarget` carries. Looking it up
    // by ref found nothing, so the panel opened onto "select a thread".
    typeof composerDraftTarget === "string"
      ? store.getDraftSession(composerDraftTarget)
      : store.getDraftSessionByRef(composerDraftTarget),
  );
  const diffEnvironmentId = activeThread?.environmentId ?? draftThread?.environmentId ?? null;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useProject(
    diffEnvironmentId && activeProjectId
      ? {
          environmentId: diffEnvironmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const projectCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const activeCwd =
    projectCwd && openRepository ? `${projectCwd.replace(/\/$/, "")}/${openRepository}` : projectCwd;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(diffEnvironmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    diffEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const gitStatusQuery = useEnvironmentQuery(
    diffEnvironmentId !== null && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: diffEnvironmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  /**
   * What the scope and base-ref pickers write against.
   *
   * A draft route has no thread ref, and every picker here bailed on that —
   * the panel was stuck on whatever scope it opened with, which in a folder of
   * repositories meant "branch changes" and so only the one repo that had
   * commits ahead. The draft carries the same pre-allocated thread id the
   * server thread will get, so a selection made now survives the promotion.
   */
  const diffSelectionRef =
    routeThreadRef ??
    (draftThread ? scopeThreadRef(draftThread.environmentId, draftThread.threadId) : null);
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(
      state.byThreadKey,
      diffSelectionRef,
      initialGitScope === "unstaged",
    ),
  );
  const openRepositoryDiffTab = useRightPanelStore((state) => state.openRepositoryDiff);
  /**
   * Opening a repository opens a tab, not an in-place drill.
   *
   * Drilling meant this surface could show one repository at a time and going
   * back lost the place; a tab behaves like everything else the panel opens.
   */
  const openRepositoryInTab = useCallback(
    (repository: string) => {
      if (diffSelectionRef === null) {
        setOpenRepository(repository);
        return;
      }
      openRepositoryDiffTab(diffSelectionRef, repository);
    },
    [diffSelectionRef, openRepositoryDiffTab],
  );

  /**
   * Source control, toggled on inside this panel rather than living in a tab
   * of its own: it describes the very patch on screen, and the comment
   * affordances, scope and scroll all belong to this panel.
   */
  const [scmOverride, setScmOverride] = useState<GitStatus | null>(null);
  const polledStatus = gitStatusQuery.data ?? null;
  useEffect(() => {
    // A fresh poll supersedes a write's answer; it is the one that sees the
    // outside world.
    setScmOverride(null);
  }, [polledStatus]);
  const scmStatus = scmOverride ?? (polledStatus as GitStatus | null);

  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.turnId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedTurnId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  /**
   * The panel is working-tree only, while the scope picker is gone. A stored
   * selection of "branch changes" would otherwise strand it there with no
   * control left to change it back, so the branch scope is not resolved here
   * at all.
   */
  const REVIEW_SCOPE_ID = "unstaged";
  const selectedBaseRef = diffSelection.kind === "branch" ? diffSelection.baseRef : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const selectedScopeLabel =
    selectedTurnId === null
      ? "Working tree"
      : selectedTurn?.turnId === latestTurn?.turnId
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.turnId}` : REVIEW_SCOPE_ID;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const collapsedDiffFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : "Working tree";
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: diffEnvironmentId,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const primaryBranchDiffPreview = useEnvironmentQuery(
    selectedTurnId === null && diffEnvironmentId && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: diffEnvironmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const shouldRetryBranchDiffAtEnvironmentCwd =
    selectedTurnId === null &&
    primaryBranchDiffPreview.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackBranchDiffPreview = useEnvironmentQuery(
    shouldRetryBranchDiffAtEnvironmentCwd && diffEnvironmentId && serverConfig
      ? reviewEnvironment.diffPreview({
          environmentId: diffEnvironmentId,
          input: {
            cwd: serverConfig.cwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const branchDiffPreview = shouldRetryBranchDiffAtEnvironmentCwd
    ? fallbackBranchDiffPreview
    : primaryBranchDiffPreview;
  /**
   * A folder of repositories, not one itself.
   *
   * There is no single branch, remote or base ref here — each repository
   * resolved its own — so the header says what it is comparing instead of
   * offering a ref picker that could not mean anything.
   */
  const workspaceRepositories = branchDiffPreview.data?.workspaceRepositories ?? null;
  /** The list stands in for the diff only at the folder level. */
  const showingRepositoryList = openRepository === null && (workspaceRepositories?.length ?? 0) > 0;
  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) => source.kind === "working-tree",
  );
  const gitDiff = selectedGitSource?.diff;

  /**
   * Re-read the diff as the thread works.
   *
   * The agent writing a file is invisible to these queries: each asks git once
   * and then holds that answer for as long as its inputs are unchanged. So
   * without this the panel keeps showing the working tree as it was when the
   * panel opened, and every file the agent touches while you watch it is
   * simply missing from the diff — which is what made the panel look frozen.
   *
   * Three things say "look again", because no one of them sees every write:
   *
   *   - the thread moving. `updatedAt` is loop's persisted session timestamp
   *     and its running flag settles the tree at the end of a turn, but it
   *     only advances when a step's messages are written — which happens
   *     AFTER the step's tool calls, not when a file is.
   *   - the working tree changing. The status subscription re-reads `git
   *     status` (with per-file line counts) every five seconds and pushes only
   *     when the answer differs, so this is the trigger that catches a write
   *     nothing told the thread about: a terminal command, the user's own
   *     editor, a subagent.
   *   - a plain interval while the agent is working, below, which is what
   *     makes an `edit` mid-step show up while it still means something.
   *
   * The refresh function is read through a ref rather than listed as a
   * dependency: `useAtomRefresh` returns a new closure whenever the underlying
   * atom changes, and depending on it would re-run this effect on every
   * refresh it performs.
   */
  const refreshSelectedPatch = useRef<() => void>(() => {});
  refreshSelectedPatch.current = selectedTurn
    ? activeCheckpointDiff.refresh
    : branchDiffPreview.refresh;
  const threadRevision = activeThread?.updatedAt ?? null;
  const threadIsRunning = activeThread?.session?.status === "running";
  const workingTreeRevision = gitStatusQuery.data;
  const documentVisible = useDocumentVisible();
  // `documentVisible` is a revision like the others: the tree can move while the
  // window is hidden and the poll below is not running, so coming back is a
  // reason to re-read. Debounced with the rest rather than refreshed on the
  // spot, so returning to the app costs one refresh and not two.
  useEffect(() => {
    if (threadRevision === null && workingTreeRevision === null) return;
    const timer = setTimeout(() => refreshSelectedPatch.current(), DIFF_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [documentVisible, threadRevision, threadIsRunning, workingTreeRevision]);
  // Only for a selection that reads the tree as it is now. A turn's checkpoint
  // diff is a pair of commits that already happened — polling it would be a
  // `git diff` every second and a half for an answer that cannot change.
  //
  // Gated on visibility too: the poll exists to keep on-screen state current, so
  // behind a hidden window it is a `git diff` subprocess every second and a half
  // that nobody reads.
  const shouldPollWorkingTree = threadIsRunning && selectedTurn === undefined && documentVisible;
  useEffect(() => {
    if (!shouldPollWorkingTree) return;
    const timer = setInterval(() => refreshSelectedPatch.current(), DIFF_REFRESH_WHILE_RUNNING_MS);
    return () => clearInterval(timer);
  }, [shouldPollWorkingTree]);

  const selectedPatch = selectedTurn ? activeCheckpointDiff.data?.diff : gitDiff;
  const isSelectedPatchTruncated = !selectedTurn && selectedGitSource?.truncated === true;
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : branchDiffPreview.isPending;
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
        compactPartialHunkOffsets: selectedTurnId === null,
      }),
    [resolvedTheme, selectedPatch, selectedTurnId],
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

  useEffect(() => {
    if (!selectedFilePath) return;
    const file = codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath);
    if (!file) return;
    codeViewRef.current?.scrollTo({ type: "item", id: file.fileKey, align: "start" });
  }, [codeViewFiles, selectedFilePath, selectedFileRevealRequestId]);

  const openDiffFile = useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    },
    [activeCwd, openInPreferredEditor, routeThreadRef],
  );
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
    [collapseScopeKey],
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
  }, [collapseScopeKey, diffFileKeys]);

  const selectTurn = (turnId: TurnId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, turnId);
  };

  const headerRow = (
    <>
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
        {activeCwd != null && selectedTurnId === null && !showingRepositoryList ? (
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
        {openRepository !== null && pinnedRepository === undefined ? (
          <button
            type="button"
            onClick={() => setOpenRepository(null)}
            className="inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-md bg-muted/70 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Back to all repositories (currently ${openRepository})`}
          >
            <ChevronLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{openRepository}</span>
          </button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {codeViewFiles.length > 0 && (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-[11px]"
            layout="inline"
          />
        )}
        {codeViewFiles.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="outline"
                  aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleDiffFileCollapse}
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
        )}
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
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeCwd ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : showingRepositoryList ? (
        <WorkspaceRepositoryList
          repositories={workspaceRepositories ?? []}
          onOpen={openRepositoryInTab}
        />
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedTurnId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
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
                  label={
                    selectedTurn ? "Loading checkpoint diff..." : "Loading working tree diff..."
                  }
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
              <div
                className="min-h-0 flex-1"
                onClickCapture={(event) => {
                  const composedPath = event.nativeEvent.composedPath?.() ?? [];
                  const title = composedPath.find(
                    (node): node is HTMLElement =>
                      node instanceof HTMLElement && node.hasAttribute("data-title"),
                  );
                  const filePath = title?.textContent?.trim();
                  if (filePath) openDiffFile(filePath);
                }}
              >
                <AnnotatableCodeView
                  viewerRef={codeViewRef}
                  key={collapseScopeKey ?? reviewSectionId}
                  className="diff-render-surface h-full min-h-0 overflow-auto"
                  files={codeViewFiles}
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
                  selectedTurnId === null &&
                  hasIndexView(scmStatus) &&
                  typeof loopGit()?.discard === "function"
                    ? {
                        renderHeaderMetadata: (fileDiff: { name: string }) => (
                          <DiscardFileButton
                            cwd={activeCwd}
                            path={fileDiff.name}
                            status={scmStatus}
                            onDiscarded={(next) => {
                              setScmOverride(next);
                              refreshSelectedPatch.current();
                            }}
                          />
                        ),
                      }
                    : {})}
                  sectionId={reviewSectionId}
                  sectionTitle={reviewSectionTitle}
                  composerDraftTarget={composerDraftTarget}
                  renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
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
                                toggleDiffFileCollapsed(fileKey);
                              }}
                            />
                          }
                        >
                          {collapsed ? (
                            <ChevronRightIcon className="size-4" />
                          ) : (
                            <ChevronDownIcon className="size-4" />
                          )}
                        </TooltipTrigger>
                        <TooltipPopup side="top">
                          {collapsed ? "Expand diff" : "Collapse diff"}
                        </TooltipPopup>
                      </Tooltip>
                    );
                  }}
                  options={{
                    diffStyle: diffRenderMode === "split" ? "split" : "unified",
                    lineDiffType: "none",
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme as DiffThemeType,
                    unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                    stickyHeaders: true,
                    itemMetrics: { diffHeaderHeight: 33 },
                    layout: { paddingTop: 0, paddingBottom: 8, gap: 8 },
                  }}
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
