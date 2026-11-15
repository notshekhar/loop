import type { AdvertisedEndpoint } from "@loop/contracts";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SettingsRow } from "../settingsLayout";
import type { AccessSectionPresentation } from "./accessRows";
import { AdvertisedEndpointListRow } from "./AdvertisedEndpointListRow";
import { BusyLabel } from "./BusyLabel";
import { endpointDefaultPreferenceKey } from "./advertisedEndpoints";
import type { AdvertisedEndpoints } from "./useAdvertisedEndpoints";
import type { DesktopNetworkExposure } from "./useDesktopNetworkExposure";
import type { TailscaleServe } from "./useTailscaleServe";

function NetworkAccessDescription({
  endpoint,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
  fallback,
}: {
  endpoint: AdvertisedEndpoint | null;
  hiddenEndpointCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  fallback: ReactNode;
}) {
  if (!endpoint) {
    return fallback;
  }

  const summary = (
    <>
      <span className="min-w-0 truncate">{endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <span className="shrink-0 text-xs font-medium">
          {expanded ? "Hide" : `+${hiddenEndpointCount}`}
        </span>
      ) : null}
    </>
  );

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0">Reachable at</span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-baseline gap-2 border-b border-dotted border-muted-foreground/60 text-left text-muted-foreground underline-offset-4 hover:border-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {summary}
        </button>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">{summary}</span>
      )}
    </span>
  );
}

function exposureFallbackDescription(exposure: DesktopNetworkExposure): string {
  const state = exposure.serverExposureState;
  return state?.endpointUrl
    ? `Reachable at ${state.endpointUrl}`
    : state?.advertisedHost
      ? `Exposed on all interfaces. Pairing links use ${state.advertisedHost}.`
      : "Exposed on all interfaces.";
}

export function NetworkAccessRow({
  exposure,
  endpoints,
}: {
  exposure: DesktopNetworkExposure;
  endpoints: AdvertisedEndpoints;
}) {
  return (
    <SettingsRow
      title="Network access"
      description={
        exposure.isNetworkAccessible ? (
          <NetworkAccessDescription
            endpoint={endpoints.defaultNetworkEndpoint}
            hiddenEndpointCount={Math.max(endpoints.visibleNetworkEndpoints.length - 1, 0)}
            expanded={endpoints.isListExpanded}
            onToggleExpanded={endpoints.toggleListExpanded}
            fallback={exposureFallbackDescription(exposure)}
          />
        ) : exposure.serverExposureState ? (
          "Limited to this machine."
        ) : (
          "Loading…"
        )
      }
      status={
        exposure.error ? <span className="block text-destructive">{exposure.error}</span> : null
      }
      control={
        <Switch
          checked={exposure.serverExposureState?.mode === "network-accessible"}
          disabled={!exposure.serverExposureState || exposure.isUpdating}
          onCheckedChange={exposure.requestModeChange}
          aria-label="Enable network access"
        />
      }
    />
  );
}

export function DisabledNetworkAccessRow({
  currentAuthPolicy,
  isNetworkAccessible,
}: {
  currentAuthPolicy: string | null;
  isNetworkAccessible: boolean;
}) {
  return (
    <SettingsRow
      title="Network access"
      description={
        currentAuthPolicy === "remote-reachable"
          ? "This backend is already configured for remote access. Network exposure changes must be made where the server is launched."
          : "This backend is only reachable on this machine. Restart it with a non-loopback host to enable remote pairing."
      }
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Switch checked={isNetworkAccessible} disabled aria-label="Enable network access" />
              </span>
            }
          />
          <TooltipPopup side="top">
            Network exposure changes restart the backend and must be controlled where the server
            process is launched.
          </TooltipPopup>
        </Tooltip>
      }
    />
  );
}

export function EndpointRows({
  presentation,
  endpoints,
  tailscale,
}: {
  presentation: AccessSectionPresentation;
  endpoints: AdvertisedEndpoints;
  tailscale: TailscaleServe;
}) {
  return endpoints.isListExpanded
    ? endpoints.visibleNetworkEndpoints.map((endpoint) => {
        const endpointKey = endpointDefaultPreferenceKey(endpoint);
        return (
          <AdvertisedEndpointListRow
            key={endpoint.id}
            endpoint={endpoint}
            isDefault={endpointKey === endpoints.defaultEndpointKey}
            presentation={presentation}
            onSetDefault={endpoints.handleSetDefault}
            onSetupTailscaleServe={tailscale.handleStartSetup}
            onDisableTailscaleServe={tailscale.handleStartDisable}
            isUpdatingTailscaleServe={tailscale.isUpdating}
          />
        );
      })
    : null;
}

export function NetworkExposureConfirmDialog({ exposure }: { exposure: DesktopNetworkExposure }) {
  const { pendingMode, isUpdating } = exposure;
  return (
    <AlertDialog
      open={exposure.isDialogOpen}
      onOpenChange={(open) => {
        if (isUpdating) return;
        exposure.setIsDialogOpen(open);
      }}
      onOpenChangeComplete={(open) => {
        if (!open) exposure.setPendingMode(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pendingMode === "network-accessible"
              ? "Enable network access?"
              : "Disable network access?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pendingMode === "network-accessible"
              ? "Loop will restart to expose this environment over the network."
              : "Loop will restart and limit this environment back to this machine."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={isUpdating}
            render={<Button variant="outline" disabled={isUpdating} />}
          >
            Cancel
          </AlertDialogClose>
          <Button
            variant={pendingMode === "local-only" ? "destructive" : "default"}
            onClick={exposure.handleConfirmChange}
            disabled={pendingMode === null || isUpdating}
          >
            {isUpdating ? (
              <BusyLabel>Restarting…</BusyLabel>
            ) : pendingMode === "network-accessible" ? (
              "Restart and enable"
            ) : (
              "Restart and disable"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
