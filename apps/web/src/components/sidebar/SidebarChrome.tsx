import { ChartNoAxesColumnIcon, LayersIcon, SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { APP_BASE_NAME } from "../../branding";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarCheckUpdatesItem } from "./SidebarCheckUpdatesItem";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isDesktopShell,
}: {
  /** Whether this header doubles as the window's titlebar. */
  isDesktopShell: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  // Inside the rail shell's card the header is a row, not a titlebar, and the
  // stage art reads as a banner in the middle of the window — so from md up
  // the channel is named by the pill instead.
  const desktopPillLabel = backdropVariant
    ? resolveEnvironmentIdentificationPillLabel(stageLabel)
    : null;

  return (
    <SidebarHeader
      className={cn(
        // On phones the header is still the sheet's titlebar. From md up the
        // rail shell draws the title band above the panel, so the header is
        // just the panel's first row: no traffic-light inset, no drag region.
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:h-12 md:px-4",
        isDesktopShell && "drag-region",
      )}
    >
      {backdropVariant ? (
        <div className="md:hidden">
          <SidebarStageBackdrop variant={backdropVariant} />
        </div>
      ) : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
      {desktopPillLabel ? (
        <Badge
          className="relative z-10 ml-1.5 hidden rounded-full px-1.5 text-muted-foreground md:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {desktopPillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 md:ml-0 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        onBackdrop ? "text-white md:text-foreground" : "text-foreground",
      )}
      to="/"
    >
      <LoopWordmark />
    </Link>
  );
}

/**
 * The wordmark is set in type, so the name comes from `branding.ts` and the
 * desktop shell can override it without anyone editing a path.
 */
function LoopWordmark() {
  return (
    <span
      aria-label={APP_BASE_NAME}
      className="truncate text-sm font-medium tracking-tight md:text-[17px] md:font-semibold"
    >
      {APP_BASE_NAME}
    </span>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  // One handler shape for both rows: closing the mobile drawer is part of
  // navigating away from it, not part of what each destination means.
  const navigateFromFooter = useCallback(
    (to: "/usage" | "/artifacts" | "/settings") => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleUsageClick = useCallback(() => navigateFromFooter("/usage"), [navigateFromFooter]);
  const handleArtifactsClick = useCallback(
    () => navigateFromFooter("/artifacts"),
    [navigateFromFooter],
  );
  const handleSettingsClick = useCallback(
    () => navigateFromFooter("/settings"),
    [navigateFromFooter],
  );

  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      {/* From md up these destinations live on the rail (AppRail); the sheet
          sidebar on phones has no rail, so it keeps them here. */}
      <SidebarMenu className="md:hidden">
        {/* Usage sits above Settings because it is the one you open often and
            close again — spend and streak are a glance, not a configuration
            session. Unlike Settings it highlights when active: it is a
            destination in the main body, so the sidebar has to say you are
            already there. */}
        <SidebarMenuItem>
          <SidebarMenuButton isActive={pathname === "/usage"} onClick={handleUsageClick}>
            <ChartNoAxesColumnIcon />
            <span>Usage</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {/* Artifacts sits beside Usage for the same reason: it is a place you
            go to look at something, not a configuration surface, so it
            highlights when active and opens in the main body. */}
        <SidebarMenuItem>
          <SidebarMenuButton isActive={pathname === "/artifacts"} onClick={handleArtifactsClick}>
            <LayersIcon />
            <span>Artifacts</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={handleSettingsClick}>
            <SettingsIcon />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {/* Last, and only in the desktop app: an occasional errand rather than
            a destination. Unlike the rows above it navigates nowhere, so it
            never highlights. */}
        <SidebarCheckUpdatesItem />
      </SidebarMenu>
    </SidebarFooter>
  );
});
