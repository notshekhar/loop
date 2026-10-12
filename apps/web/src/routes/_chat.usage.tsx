/**
 * Usage — loop's `/cost` and `/steak`, at the top level rather than buried in
 * Settings.
 *
 * It lived under `/settings/usage` because that is where a panel goes when it
 * has nowhere else to be, but usage is something you *check*, not something
 * you *configure*: it reads a ledger and changes nothing. So it gets its own
 * sidebar entry and opens in the main body, next to the threads, with the
 * sidebar still on screen — the settings surface takes over the whole window
 * and closing it means navigating back out.
 *
 * The panel component is unchanged and still lives under `components/loop`;
 * only its host moved.
 */
import { createFileRoute } from "@tanstack/react-router";

import { LoopUsageSettings } from "../components/loop/LoopUsageSettings";
import { SidebarInset } from "../components/ui/sidebar";
import { ownsWindowChrome } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function UsageRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {/* Same two headers the rest of the app uses: a plain topbar in the
            browser, and a taller draggable strip in the desktop shell where
            this row IS the titlebar. */}
        {ownsWindowChrome ? (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Usage
            </span>
          </div>
        ) : (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <div className="flex w-full items-center gap-2">
              <span className="text-sm font-medium text-foreground">Usage</span>
            </div>
          </header>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <LoopUsageSettings />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/usage")({
  component: UsageRouteView,
});
