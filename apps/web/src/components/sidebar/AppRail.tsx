import {
  ChartNoAxesColumnIcon,
  HouseIcon,
  LayersIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useDesktopUpdateCheck } from "../useDesktopUpdateCheck";

/**
 * The shell's icon rail: the app's destinations as one slim column left of the
 * panel, the way Synara (and Codex) lay out their window.
 *
 * The panel beside it is whatever sidebar style the user picked, so the rail
 * carries only what every style shares — the places you go, not the list you
 * work from. Those rows used to sit in each panel's footer; on phones the rail
 * is not drawn and the footer keeps them (see SidebarChromeFooter).
 */
type RailDestination = "/" | "/usage" | "/artifacts" | "/settings";

function RailButton({
  icon: Icon,
  label,
  active = false,
  busy = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-current={active ? "page" : undefined}
            aria-label={label}
            className={cn(
              "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-hidden ring-ring transition-colors focus-visible:ring-2",
              active
                ? "bg-[var(--app-rail-item-active)] text-foreground"
                : "text-muted-foreground/75 hover:bg-[var(--app-rail-item-hover)] hover:text-foreground",
            )}
            disabled={busy}
            onClick={onClick}
            type="button"
          />
        }
      >
        <Icon
          aria-hidden
          className={cn("size-[18px]", busy && "animate-spin")}
          strokeWidth={1.75}
        />
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Desktop-only, like the footer row it replaces: a build that cannot update shows nothing. */
function RailCheckUpdatesButton() {
  const { available, busy, run } = useDesktopUpdateCheck();
  if (!available) return null;
  return (
    <RailButton
      busy={busy}
      icon={RefreshCwIcon}
      label={busy ? "Checking for updates…" : "Check for updates"}
      onClick={run}
    />
  );
}

export const AppRail = memo(function AppRail() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const go = useCallback((to: RailDestination) => void navigate({ to }), [navigate]);

  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const onUsage = pathname === "/usage";
  const onArtifacts = pathname === "/artifacts";

  return (
    <nav
      aria-label="Primary"
      className="app-rail relative z-20 hidden w-(--app-rail-width) shrink-0 flex-col items-center gap-1.5 pt-[calc(var(--workspace-topbar-height)+0.25rem)] pb-2.5 md:flex"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5">
        {/* Home is every thread surface — the panel decides which one. */}
        <RailButton
          active={!onSettings && !onUsage && !onArtifacts}
          icon={HouseIcon}
          label="Home"
          onClick={() => go("/")}
        />
        <RailButton icon={SearchIcon} label="Search" onClick={() => openCommandPalette()} />
        <RailButton
          active={onUsage}
          icon={ChartNoAxesColumnIcon}
          label="Usage"
          onClick={() => go("/usage")}
        />
        <RailButton
          active={onArtifacts}
          icon={LayersIcon}
          label="Artifacts"
          onClick={() => go("/artifacts")}
        />
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        <RailCheckUpdatesButton />
        <RailButton
          active={onSettings}
          icon={SettingsIcon}
          label="Settings"
          onClick={() => go("/settings")}
        />
      </div>
    </nav>
  );
});
