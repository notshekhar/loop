import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isDesktopShell } from "../env";
import { loopWindow } from "../loop/transport";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  useSidebarStyle,
  useSidebarV2Enabled,
} from "../hooks/useSettings";
import type { SidebarStyle } from "@loop/contracts/settings";
import FocusedSidebar from "./loop/FocusedSidebar";
import ProjectSidebar from "./loop/ProjectSidebar";
import SidebarV2 from "./SidebarV2";
import { AppRail } from "./sidebar/AppRail";
import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              className="pointer-events-auto"
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * The sidebar the user picked in Settings → Appearance.
 *
 * Three different answers to "what is this panel a list of", not three skins —
 * see `SidebarStyle` in the settings contract. `threads` is upstream's own
 * sidebar and stays the default; the other two are loop's.
 */
function SelectedSidebar({ style }: { style: SidebarStyle }) {
  if (style === "projects") return <ProjectSidebar />;
  if (style === "focused") return <FocusedSidebar />;
  return <SidebarV2 />;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const sidebarV2Enabled = useSidebarV2Enabled();
  const sidebarStyle = useSidebarStyle();
  // Settings routes render the settings nav, which lives in the v1 component
  // and is identical for both sidebars — so v1 stays mounted there.
  const pathname = useLocation({ select: (location) => location.pathname });
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const useSidebarV2 = sidebarV2Enabled && !isOnSettings;
  const useSidebarV2Theme = useSidebarV2 || isOnSettings;
  // isDesktopShell, not isElectron: loop's preload exposes `window.loop` and
  // never upstream's `window.desktopBridge`, so isElectron is false here and
  // the traffic lights would be left sitting on the sidebar header.
  const isMacosDesktop = isDesktopShell && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth);
  // Starts false and is corrected on mount: loop's bridge answers this
  // asynchronously over IPC, and false is the right guess anyway — the inset
  // is only wrong while fullscreen, which a fresh window is not.
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const sidebarProviderStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    ...(isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const host = loopWindow();
    if (!host) return;

    // Subscribe before asking, so a transition during the round trip is not
    // missed — and let it win, because the reply describes the window as it
    // was when the question was asked.
    let cancelled = false;
    let transitioned = false;
    const unsubscribe = host.onFullscreenChange((fullscreen) => {
      transitioned = true;
      setIsWindowFullscreen(fullscreen);
    });
    void host
      .isFullscreen()
      .then((fullscreen) => {
        if (!cancelled && !transitioned) setIsWindowFullscreen(fullscreen);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isMacosDesktop]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    // The rail shell: a slim icon rail on the window's ground, and the panel
    // plus the page sitting together in one inset card below the title band
    // (see `[data-shell="rail"]` in index.css).
    <SidebarProvider
      className="h-dvh! min-h-0! overflow-hidden bg-[var(--app-shell-background)]"
      data-shell="rail"
      defaultOpen
      style={sidebarProviderStyle}
    >
      {isDesktopShell ? (
        // The band over the rail and panel has no route header to drag by.
        <div
          aria-hidden
          className="drag-region fixed top-0 left-0 z-0 hidden h-[var(--workspace-topbar-height)] w-[calc(var(--app-rail-width)+var(--sidebar-width))] md:block group-data-[sidebar-state=collapsed]/sidebar-wrapper:w-(--app-rail-width)"
        />
      ) : null}
      <AppRail />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        data-sidebar-version={useSidebarV2Theme ? "v2" : "v1"}
        className="text-sidebar-foreground"
        resizable={{
          maxWidth: sidebarMaximumWidth,
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            nextWidth <= currentWidth ||
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
          onResize: setSidebarWidth,
        }}
      >
        {/* Upstream's own sidebar, driven by loop.

            The hand-written projects-only list it replaces was missing
            everything this does — removing and renaming a project, the row
            context menus, search, multi-select, jump hints, project grouping —
            and re-implementing all of that would be rewriting this file badly.
            Vendored from the same commit as the rest of the fork so it agrees
            with the runtime; nightly's version wants a `threadPinning`
            capability and pinned-reorder helpers that came after our base.
            Settings still swaps in the section nav below. */}
        {isOnSettings ? <ProjectSidebar /> : <SelectedSidebar style={sidebarStyle} />}
        <SidebarRail />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
