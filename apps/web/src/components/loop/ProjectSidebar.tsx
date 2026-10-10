/**
 * loop's sidebar: projects, and nothing else.
 *
 * Upstream shipped two sidebars (3.6k and 3.2k lines) that nest every thread
 * under its project, so the list is as long as your entire history. loop's
 * navigation is one level shallower on purpose — the sidebar answers "which
 * folder", and the project view answers "which session in it". Neither
 * inherited sidebar is a starting point for that, so this is written rather
 * than carved out of them.
 *
 * A row therefore has to carry what the nesting used to show at a glance: how
 * many sessions the folder holds, whether any is running, and how recently it
 * was touched. Starting a session is the one action a row offers, and it is
 * revealed on hover so the resting list stays a list of folders.
 *
 * Projects come from the same atoms the old sidebars used, so this is a
 * presentation change only: no new data path, and the shell handler stays the
 * one place that decides what a project is.
 *
 * Two rules carry the shortest list here past "just shorter":
 *
 * - Threads waiting on YOU are lifted out of their folders into a shelf above
 *   the list, oldest ask first. A folder-first list is otherwise the easiest
 *   place in the app to leave a blocked thread sitting behind a collapsed row.
 * - A folder row carries the state of what is inside it, not just a count — an
 *   amber dot for an ask, a pulsing one for live work. Eleven sessions tells
 *   you nothing about whether one of them is stuck.
 *
 * See `sidebarThreads.logic.ts` for the classification both this and the
 * focused sidebar run on.
 */
import { LoadMoreSentinel } from "./LoadMoreSentinel";
import { useSessionPaging } from "../../loop/useSessionPaging";
import { scopeProjectRef } from "@loop/runtime/environment";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type MouseEvent } from "react";
import { Link, useLocation, useParams } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isDesktopShell } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { useUiStateStore } from "../../uiStateStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SettingsSidebarNav } from "../settings/SettingsSidebarNav";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { ComputerPicker, useScopedSidebarEntities } from "../sidebar/ComputerPicker";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import {
  buildProjectSidebarRows,
  compactTimeLabel,
  resolveActiveProjectId,
  SIDEBAR_SETTLED_PAGE,
  type ProjectSidebarRow,
} from "./ProjectSidebar.logic";
import { ProjectRowMenu, ProjectTitleEditor } from "./ProjectRowMenu";
import { SidebarSectionHeader, SidebarThreadRow } from "./SidebarThreadRows";
import { useProjectActions, type ProjectActionTarget } from "./useProjectActions";
import { useThreadRowActions } from "./useThreadRowActions";
import {
  buildSidebarThreadSections,
  rollupForProject,
  sectionsForProject,
  type ProjectRollup,
  type SidebarThreadSections,
  type SidebarThreadRow as ThreadRowModel,
} from "./sidebarThreads.logic";
import { decodeProjectRouteId, encodeProjectRouteId } from "./projectRoute";

/**
 * A project's threads, under the project.
 *
 * The sidebar answers "which folder" and the project page answers "which
 * thread in it" — but switching between two or three threads in the same
 * folder is something people do constantly, and routing that through a second
 * page every time is friction.
 *
 * Working first, then recent, then the settled shelf. Threads waiting on you
 * appear here too rather than only in the shelf above: a folder you have opened
 * should show everything it holds, or the missing row reads as a bug.
 */
const ProjectThreadList = memo(function ProjectThreadList({
  sections,
  settledVisible,
  settledOpen,
  onToggleSettled,
  onShowMoreSettled,
  activeThreadId,
  onThreadContextMenu,
  onArchiveThread,
  folder,
}: {
  /** The folder this list is, for paging its sessions (useSessionPaging). */
  folder: { readonly environmentId: string; readonly cwd: string };
  sections: SidebarThreadSections;
  settledVisible: number;
  settledOpen: boolean;
  onToggleSettled: () => void;
  onShowMoreSettled: () => void;
  activeThreadId: string | null;
  onThreadContextMenu: (row: ThreadRowModel, position: { x: number; y: number }) => void;
  onArchiveThread: (row: ThreadRowModel) => void;
}) {
  const open = [...sections.needsYou, ...sections.working, ...sections.recent];
  const settled = sections.settled.slice(0, settledVisible);
  const remaining = sections.settled.length - settled.length;
  // An open folder lists its own newest page, then the next as you scroll.
  const sessionPaging = useSessionPaging({ environmentIds: [], folders: [folder] });
  if (open.length === 0 && sections.settled.length === 0) return null;

  return (
    // mt-1 is not decoration: without it the first thread sits flush against
    // the project row and the two read as one block, so the folder stops
    // looking like the thing the threads hang off.
    <div className="mt-1 ml-3 flex flex-col gap-px border-sidebar-border/50 border-l pl-1">
      {open.map((row) => (
        <SidebarThreadRow
          active={row.id === activeThreadId}
              activeThreadId={activeThreadId}
          key={row.id}
          onArchive={onArchiveThread}
          onContextMenu={onThreadContextMenu}
          row={row}
        />
      ))}
      {sections.settled.length > 0 ? (
        <SidebarSectionHeader
          count={sections.settled.length}
          label="Settled"
          onToggle={onToggleSettled}
          open={settledOpen}
        />
      ) : null}
      {settledOpen ? (
        <>
          {settled.map((row) => (
            <SidebarThreadRow
              active={row.id === activeThreadId}
              activeThreadId={activeThreadId}
              key={row.id}
              onArchive={onArchiveThread}
              onContextMenu={onThreadContextMenu}
              row={row}
            />
          ))}
          {remaining > 0 || sessionPaging.hasMore || sessionPaging.loading ? (
            <LoadMoreSentinel
              itemCount={settled.length}
              loading={sessionPaging.loading}
              onVisible={() => {
                if (remaining > 0) onShowMoreSettled();
                else if (sessionPaging.hasMore) sessionPaging.loadMore();
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
});

/**
 * The figure on the right of a folder row.
 *
 * Ordered by urgency and cut off after the first two marks, because the row has
 * about forty pixels: an ask, then live work, then how many threads are open
 * and when the folder last moved.
 */
const ProjectRollupFigure = memo(function ProjectRollupFigure({
  rollup,
}: {
  rollup: ProjectRollup;
}) {
  const relativeTime =
    rollup.lastActivity > 0
      ? compactTimeLabel(formatRelativeTimeLabel(new Date(rollup.lastActivity).toISOString()))
      : null;
  const title = [
    rollup.needsYou > 0 ? `${rollup.needsYou} waiting on you` : null,
    rollup.working > 0 ? `${rollup.working} running` : null,
    `${rollup.openCount} open`,
  ]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <span
      className="flex shrink-0 items-center gap-1 font-normal text-[10px] text-sidebar-muted-foreground/55 tabular-nums"
      title={title}
    >
      {rollup.needsYou > 0 ? (
        <span aria-hidden className="size-1.5 rounded-full bg-warning" />
      ) : null}
      {rollup.working > 0 ? (
        <span aria-hidden className="size-1.5 animate-status-pulse rounded-full bg-info" />
      ) : null}
      {rollup.openCount > 0 ? <span>{rollup.openCount}</span> : null}
      {relativeTime === null ? null : (
        <>
          <span aria-hidden className="text-sidebar-muted-foreground/35">·</span>
          <span>{relativeTime}</span>
        </>
      )}
    </span>
  );
});

const ProjectRowItem = memo(function ProjectRowItem({
  project,
  rollup,
  active,
  expanded,
  renaming,
  onToggle,
  onNewSession,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onCopyPath,
  onRemove,
  onProjectContextMenu,
  onThreadContextMenu,
  onArchiveThread,
  sections,
  activeThreadId,
}: {
  project: ProjectSidebarRow;
  rollup: ProjectRollup;
  active: boolean;
  expanded: boolean;
  renaming: boolean;
  onToggle: (project: ProjectSidebarRow) => void;
  onNewSession: (project: ProjectActionTarget) => void;
  onStartRename: (project: ProjectActionTarget) => void;
  onCommitRename: (project: ProjectActionTarget, title: string) => void;
  onCancelRename: () => void;
  onCopyPath: (project: ProjectActionTarget) => void;
  onRemove: (project: ProjectActionTarget) => void;
  onProjectContextMenu: (
    project: ProjectActionTarget,
    position: { x: number; y: number },
    handlers: { onNewThread: () => void; onStartRename: () => void },
  ) => void;
  onThreadContextMenu: (row: ThreadRowModel, position: { x: number; y: number }) => void;
  onArchiveThread: (row: ThreadRowModel) => void;
  sections: SidebarThreadSections | null;
  activeThreadId: string | null;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const [settledVisible, setSettledVisible] = useState(SIDEBAR_SETTLED_PAGE);
  const onToggleSettled = useCallback(() => setSettledOpen((open) => !open), []);
  const onShowMoreSettled = useCallback(
    () => setSettledVisible((count) => count + SIDEBAR_SETTLED_PAGE),
    [],
  );

  return (
    <SidebarMenuItem>
      {/* pr-8 keeps the figure clear of the hover action overlaying the right
          edge. */}
      <SidebarMenuButton
        className="pr-8"
        isActive={active}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          onProjectContextMenu(
            project,
            { x: event.clientX, y: event.clientY },
            {
              onNewThread: () => onNewSession(project),
              onStartRename: () => onStartRename(project),
            },
          );
        }}
        render={
          <Link params={{ projectId: encodeProjectRouteId(project.id) }} to="/project/$projectId" />
        }
        tooltip={project.workspaceRoot}
      >
        {/* The disclosure sits inside the row but swallows the click, so the
            row itself still navigates to the project page. */}
        <span
          aria-label={expanded ? `Collapse ${project.title}` : `Expand ${project.title}`}
          className="-m-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded p-1 hover:bg-sidebar-row-hover"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle(project);
          }}
          role="button"
          tabIndex={-1}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </span>
        <FolderIcon />
        {renaming ? (
          <ProjectTitleEditor
            onCancel={onCancelRename}
            onCommit={(title) => onCommitRename(project, title)}
            title={project.title}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{project.title}</span>
        )}
        {renaming ? null : <ProjectRollupFigure rollup={rollup} />}
      </SidebarMenuButton>
      {/* The `!` inside ProjectRowMenu's className is load-bearing: the
          component's own `peer-data-[size=default]/menu-button:top-1.5` is a
          variant selector and outranks a plain `top-1/2`. */}
      {renaming ? null : (
        <ProjectRowMenu
          onCopyPath={onCopyPath}
          onNewThread={onNewSession}
          onRemove={onRemove}
          onStartRename={onStartRename}
          project={project}
        />
      )}
      {expanded && sections ? (
        <ProjectThreadList
          folder={{ environmentId: project.environmentId, cwd: project.id }}
          activeThreadId={activeThreadId}
          onArchiveThread={onArchiveThread}
          onShowMoreSettled={onShowMoreSettled}
          onThreadContextMenu={onThreadContextMenu}
          onToggleSettled={onToggleSettled}
          sections={sections}
          settledOpen={settledOpen}
          settledVisible={settledVisible}
        />
      ) : null}
    </SidebarMenuItem>
  );
});

/**
 * Threads waiting on you, across every project.
 *
 * The one part of this sidebar that ignores folders. A blocked thread behind a
 * collapsed row is the failure mode a folder-first list invites, and the fix
 * cannot itself be a folder you have to open.
 */
const NeedsYouShelf = memo(function NeedsYouShelf({
  rows,
  activeThreadId,
  onThreadContextMenu,
  onArchiveThread,
}: {
  rows: readonly ThreadRowModel[];
  activeThreadId: string | null;
  onThreadContextMenu: (row: ThreadRowModel, position: { x: number; y: number }) => void;
  onArchiveThread: (row: ThreadRowModel) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-px">
        <SidebarSectionHeader count={rows.length} label="Needs you" tone="alert" />
        {rows.map((row) => (
          <SidebarThreadRow
            active={row.id === activeThreadId}
              activeThreadId={activeThreadId}
            key={row.id}
            onArchive={onArchiveThread}
            onContextMenu={onThreadContextMenu}
            row={row}
          />
        ))}
      </SidebarGroupContent>
    </SidebarGroup>
  );
});

export default function ProjectSidebar() {
  // The chosen computer's projects and threads (ComputerPicker).
  const { projects, threads } = useScopedSidebarEntities();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const lastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const rows = useMemo(() => buildProjectSidebarRows({ projects, threads }), [projects, threads]);
  const sections = useMemo(
    () =>
      buildSidebarThreadSections(threads, {
        now: new Date().toISOString(),
        autoSettleAfterDays,
        lastVisitedAtByKey,
      }),
    [autoSettleAfterDays, lastVisitedAtByKey, threads],
  );

  const params = useParams({ strict: false }) as {
    projectId?: string;
    environmentId?: string;
    threadId?: string;
    draftId?: string;
  };
  // A draft has no server thread to look up, so it carries its own project.
  const draftProjectId = useComposerDraftStore((store) =>
    params.draftId ? (store.draftThreadsByThreadKey[params.draftId]?.projectId ?? null) : null,
  );
  const activeProjectId = useMemo(
    () =>
      resolveActiveProjectId({
        routeProjectId: params.projectId ? decodeProjectRouteId(params.projectId) : null,
        routeEnvironmentId: params.environmentId ?? null,
        routeThreadId: params.threadId ?? null,
        routeDraftProjectId: draftProjectId,
        threads,
      }),
    [draftProjectId, params.environmentId, params.projectId, params.threadId, threads],
  );

  // Starts the draft already pointed at that folder, the same way the project
  // view's own button does — the row is the one place that knows which folder
  // the user meant, and losing it means picking it again in the composer.
  const startNewThread = useNewThreadHandler();
  const onNewSession = useCallback(
    (project: ProjectActionTarget) => {
      void startNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [startNewThread],
  );

  // Rename, remove and copy-path, on the same commands and the same confirm
  // upstream's sidebar uses — see useProjectActions.
  const { renameProject, removeProject, copyProjectPath, openProjectContextMenu } =
    useProjectActions();
  const { openContextMenu, archive } = useThreadRowActions();
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const onStartRename = useCallback(
    (project: ProjectActionTarget) => setRenamingProjectId(project.id),
    [],
  );
  const onCancelRename = useCallback(() => setRenamingProjectId(null), []);
  const onCommitRename = useCallback(
    (project: ProjectActionTarget, title: string) => {
      setRenamingProjectId(null);
      void renameProject(project, title);
    },
    [renameProject],
  );
  const onRemove = useCallback(
    (project: ProjectActionTarget) => void removeProject(project),
    [removeProject],
  );

  // Which projects show their threads. The one you are in opens itself —
  // that is the list you are switching within — and anything else is a
  // deliberate toggle that then sticks.
  const [toggledProjectIds, setToggledProjectIds] = useState<ReadonlySet<string>>(new Set());
  const onToggle = useCallback((project: ProjectSidebarRow) => {
    setToggledProjectIds((existing) => {
      const next = new Set(existing);
      if (next.has(project.id)) next.delete(project.id);
      else next.add(project.id);
      return next;
    });
  }, []);
  const isExpanded = useCallback(
    (projectId: string) =>
      projectId === activeProjectId
        ? !toggledProjectIds.has(projectId)
        : toggledProjectIds.has(projectId),
    [activeProjectId, toggledProjectIds],
  );

  const pathname = useLocation({ select: (location) => location.pathname });

  // Settings replaces the whole list with its own section nav — the same swap
  // upstream did inside its sidebar. Without it the settings page shows a
  // project list and no way to move between sections, which is exactly what
  // happened once the old sidebar (the only thing mounting this nav) stopped
  // rendering.
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  if (isOnSettings) {
    return (
      <>
        <SidebarChromeHeader isDesktopShell={isDesktopShell} />
        <SettingsSidebarNav pathname={pathname} />
      </>
    );
  }

  const activeThreadId = params.threadId ?? null;

  return (
    <>
      <SidebarChromeHeader isDesktopShell={isDesktopShell} />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <ComputerPicker />
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => openCommandPalette()}>
                  <SearchIcon />
                  <span>Search</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => openCommandPalette({ open: "add-project" })}>
                  <SquarePenIcon />
                  <span>Add project</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <NeedsYouShelf
          activeThreadId={activeThreadId}
          onArchiveThread={archive}
          onThreadContextMenu={openContextMenu}
          rows={sections.needsYou}
        />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {rows.length === 0 ? (
                <SidebarMenuItem>
                  <span className="px-2 py-1.5 text-muted-foreground text-sm">No projects yet</span>
                </SidebarMenuItem>
              ) : (
                rows.map((project) => {
                  const expanded = isExpanded(project.id);
                  return (
                    <ProjectRowItem
                      active={activeProjectId === project.id}
                      activeThreadId={activeThreadId}
                      expanded={expanded}
                      key={project.id}
                      onArchiveThread={archive}
                      onCancelRename={onCancelRename}
                      onCommitRename={onCommitRename}
                      onCopyPath={copyProjectPath}
                      onProjectContextMenu={openProjectContextMenu}
                      onThreadContextMenu={openContextMenu}
                      onNewSession={onNewSession}
                      onRemove={onRemove}
                      onStartRename={onStartRename}
                      onToggle={onToggle}
                      project={project}
                      renaming={renamingProjectId === project.id}
                      rollup={rollupForProject(sections, project.id)}
                      // Derived only for the folders that are open: slicing
                      // every project's threads on every render would walk the
                      // whole history for rows nobody is looking at.
                      sections={
                        expanded
                          ? sectionsForProject(sections, project.id, project.environmentId)
                          : null
                      }
                    />
                  );
                })
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
