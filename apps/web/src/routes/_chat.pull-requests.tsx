/**
 * Pull requests — a project's PRs, read and reviewed through `gh`.
 *
 * A top-level destination like Usage and Artifacts: it opens in the main body
 * with the sidebar still on screen.
 */
import { createFileRoute } from "@tanstack/react-router";

import { PullRequestsPage } from "../components/pullRequests/PullRequestsPage";
import { SidebarInset } from "../components/ui/sidebar";
// `ownsWindowChrome`, not `isElectron`: a drag region asks whether the app
// draws its own titlebar, and `isElectron` is false inside loop's shell (env.ts).
import { ownsWindowChrome } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function PullRequestsRouteView() {
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
              Pull requests
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
              <span className="text-sm font-medium text-foreground">Pull requests</span>
            </div>
          </header>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <PullRequestsPage />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/pull-requests")({
  component: PullRequestsRouteView,
});
