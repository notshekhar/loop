/**
 * One project, the whole panel.
 *
 * The other two styles are lists of everything: `threads` groups every thread
 * under its project, `projects` lists the folders and opens one at a time.
 * This one drops the cross-project list entirely — the project moves into a
 * switcher in the header, and the body belongs to it.
 *
 * What that buys is room. With one project's threads in the panel, a row can
 * afford two lines (title, then branch) and the sections can be STATES rather
 * than dates: needs you, working, recent, settled. Each is short enough to read
 * at a glance, which is the whole reason to give up the wide view.
 *
 * What it costs is that a thread finishing in another project is invisible
 * until you switch. "Needs you" is deliberately the one section that stays
 * cross-project, so nothing can sit blocked in a folder you are not looking at.
 */
import { scopeProjectRef } from "@loop/runtime/environment";
import {
  ChevronsUpDownIcon,
  FolderIcon,
  FolderPlusIcon,
  LayersIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isDesktopShell } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { useProjects, useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "../../lib/utils";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { resolveActiveProjectId } from "./ProjectSidebar.logic";
import { decodeProjectRouteId } from "./projectRoute";
import { ProjectHeaderMenu } from "./ProjectHeaderMenu";
import { ProjectTitleEditor } from "./ProjectRowMenu";
import { SidebarSectionHeader, SidebarThreadRow } from "./SidebarThreadRows";
import { useProjectActions, type ProjectActionTarget } from "./useProjectActions";
import { useThreadRowActions } from "./useThreadRowActions";
import {
  buildSidebarThreadSections,
  sectionsForProject,
  type SidebarThreadRow as ThreadRowModel,
} from "./sidebarThreads.logic";

/** Settled threads revealed per press, matching the other styles' shelf. */
const SETTLED_PAGE = 25;

const ThreadSection = memo(function ThreadSection({
  label,
  rows,
  activeThreadId,
  onContextMenu,
  onArchive,
  collapsible = false,
  tone,
}: {
  label: string;
  rows: readonly ThreadRowModel[];
  activeThreadId: string | null;
  onContextMenu: (row: ThreadRowModel, position: { x: number; y: number }) => void;
  onArchive: (row: ThreadRowModel) => void;
  collapsible?: boolean;
  tone?: "alert";
}) {
  const [open, setOpen] = useState(true);
  const onToggle = useCallback(() => setOpen((value) => !value), []);
  // An empty section is not drawn at all. A permanently-visible "Needs you (0)"
  // is how a section stops being read.
  if (rows.length === 0) return null;
  return (
    <>
      <SidebarSectionHeader
        count={rows.length}
        label={label}
        {...(collapsible ? { onToggle, open } : {})}
        {...(tone ? { tone } : {})}
      />
      {!collapsible || open ? (
        <div className="flex flex-col gap-px">
          {rows.map((row) => (
            <SidebarThreadRow
              active={row.id === activeThreadId}
              key={row.id}
              onArchive={onArchive}
              onContextMenu={onContextMenu}
              row={row}
            />
          ))}
        </div>
      ) : null}
    </>
  );
});

export default function FocusedSidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const lastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);

  const params = useParams({ strict: false }) as {
    projectId?: string;
    environmentId?: string;
    threadId?: string;
    draftId?: string;
  };
  const draftProjectId = useComposerDraftStore((store) =>
    params.draftId ? (store.draftThreadsByThreadKey[params.draftId]?.projectId ?? null) : null,
  );
  const routeProjectId = useMemo(
    () =>
      resolveActiveProjectId({
        // The project route matters here in a way it does not for the other
        // styles: switching projects navigates to `/project/:id`, so without
        // this the panel would not follow its own switcher.
        routeProjectId: params.projectId ? decodeProjectRouteId(params.projectId) : null,
        routeEnvironmentId: params.environmentId ?? null,
        routeThreadId: params.threadId ?? null,
        routeDraftProjectId: draftProjectId,
        threads,
      }),
    [draftProjectId, params.environmentId, params.projectId, params.threadId, threads],
  );

  // The last project the route named, remembered. Routes that name no project
  // at all (the root, settings) would otherwise drop the panel back to the
  // first project alphabetically — which reads as the sidebar forgetting where
  // you were the moment you close a thread.
  const [lastProjectId, setLastProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (routeProjectId) setLastProjectId(routeProjectId);
  }, [routeProjectId]);

  const orderedProjects = useMemo(
    () => projects.toSorted((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );
  const currentProject =
    orderedProjects.find((project) => project.id === (routeProjectId ?? lastProjectId)) ??
    orderedProjects[0] ??
    null;

  // Sections come from the whole thread list, not the project's slice: "Needs
  // you" stays cross-project, and only the other three narrow.
  const sections = useMemo(
    () =>
      buildSidebarThreadSections(threads, {
        now: new Date().toISOString(),
        autoSettleAfterDays,
        lastVisitedAtByKey,
      }),
    [autoSettleAfterDays, lastVisitedAtByKey, threads],
  );
  const mine = useMemo(
    () => (currentProject ? sectionsForProject(sections, currentProject.id) : null),
    [currentProject, sections],
  );

  const [settledVisible, setSettledVisible] = useState(SETTLED_PAGE);
  const startNewThread = useNewThreadHandler();

  // The same actions the project rows carry in the other styles — with one
  // project in the panel there is no row to hang them off, so they ride the
  // header beside the switcher.
  const { renameProject, removeProject, copyProjectPath, openProjectContextMenu } =
    useProjectActions();
  const { openContextMenu, archive } = useThreadRowActions();
  const [renaming, setRenaming] = useState(false);
  const target: ProjectActionTarget | null = currentProject
    ? {
        id: currentProject.id,
        environmentId: currentProject.environmentId,
        title: currentProject.title,
        workspaceRoot: currentProject.workspaceRoot,
      }
    : null;
  const onNewThread = useCallback(() => {
    if (!currentProject) return;
    void startNewThread(scopeProjectRef(currentProject.environmentId, currentProject.id));
  }, [currentProject, startNewThread]);

  const activeThreadId = params.threadId ?? null;
  const settled = mine ? mine.settled.slice(0, settledVisible) : [];
  const settledRemaining = mine ? mine.settled.length - settled.length : 0;

  return (
    <>
      <SidebarChromeHeader isDesktopShell={isDesktopShell} />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent className="flex flex-col gap-1">
            <div
              className="flex min-w-0 items-center gap-1"
              onContextMenu={(event) => {
                if (!target) return;
                event.preventDefault();
                event.stopPropagation();
                openProjectContextMenu(
                  target,
                  { x: event.clientX, y: event.clientY },
                  { onNewThread, onStartRename: () => setRenaming(true) },
                );
              }}
            >
              {renaming && target ? (
                <ProjectTitleEditor
                  onCancel={() => setRenaming(false)}
                  onCommit={(title) => {
                    setRenaming(false);
                    void renameProject(target, title);
                  }}
                  title={target.title}
                />
              ) : (
                // The command palette rather than a select: it searches, it
                // shows each project's favicon, and it is the same list the
                // threads sidebar opens — so switching projects is one control
                // wherever you meet it.
                <button
                  aria-label="Switch project"
                  className={cn(
                    "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left",
                    "outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2",
                  )}
                  onClick={() => openCommandPalette({ open: "switch-project" })}
                  type="button"
                >
                  <FolderIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate font-medium text-[13px]">
                    {currentProject?.title ?? "No projects yet"}
                  </span>
                  <ChevronsUpDownIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-sidebar-muted-foreground/60"
                  />
                </button>
              )}
              {target && !renaming ? (
                <ProjectHeaderMenu
                  onCopyPath={copyProjectPath}
                  onRemove={(project) => void removeProject(project)}
                  onStartRename={() => setRenaming(true)}
                  project={target}
                />
              ) : null}
            </div>

            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton disabled={!currentProject} onClick={onNewThread}>
                  <PlusIcon />
                  <span>New thread</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => openCommandPalette({ open: "add-project" })}>
                  <FolderPlusIcon />
                  <span>Add project</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {/* Search lives on the rail from md up; the phone sheet has no rail. */}
              <SidebarMenuItem className="md:hidden">
                <SidebarMenuButton onClick={() => openCommandPalette()}>
                  <SearchIcon />
                  <span>Search</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                {/* The escape hatch. Focused mode's one real risk is forgetting
                    that the other projects exist. */}
                <SidebarMenuButton onClick={() => openCommandPalette()}>
                  <LayersIcon />
                  <span>All activity</span>
                  {sections.working.length > 0 ? (
                    <span className="ml-auto text-[10px] text-sidebar-muted-foreground/60 tabular-nums">
                      {sections.working.length} running
                    </span>
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupContent className="flex flex-col">
            {/* Cross-project on purpose — see the note at the top of the file. */}
            <ThreadSection
              activeThreadId={activeThreadId}
              onArchive={archive}
              onContextMenu={openContextMenu}
              label="Needs you"
              rows={sections.needsYou}
              tone="alert"
            />
            {mine ? (
              <>
                <ThreadSection
                  activeThreadId={activeThreadId}
              onArchive={archive}
              onContextMenu={openContextMenu}
                  label="Working"
                  rows={mine.working}
                />
                <ThreadSection
                  activeThreadId={activeThreadId}
              onArchive={archive}
              onContextMenu={openContextMenu}
                  collapsible
                  label="Recent"
                  rows={mine.recent}
                />
                <ThreadSection
                  activeThreadId={activeThreadId}
              onArchive={archive}
              onContextMenu={openContextMenu}
                  collapsible
                  label="Settled"
                  rows={settled}
                />
                {settledRemaining > 0 ? (
                  <button
                    className={cn(
                      "mt-1 ml-2 w-fit cursor-pointer rounded-md px-1 py-0.5 text-[11px] text-sidebar-muted-foreground/60",
                      "outline-hidden ring-ring hover:text-sidebar-foreground focus-visible:ring-2",
                    )}
                    onClick={() => setSettledVisible((count) => count + SETTLED_PAGE)}
                    type="button"
                  >
                    Show {Math.min(settledRemaining, SETTLED_PAGE)} more
                  </button>
                ) : null}
                {mine.needsYou.length === 0 &&
                mine.working.length === 0 &&
                mine.recent.length === 0 &&
                mine.settled.length === 0 ? (
                  <p className="px-2 py-3 text-[13px] text-sidebar-muted-foreground">
                    No threads in {currentProject?.title} yet.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="px-2 py-3 text-[13px] text-sidebar-muted-foreground">No projects yet</p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
