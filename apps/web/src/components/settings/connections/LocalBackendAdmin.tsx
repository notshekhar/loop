import type { ServerUpdateState } from "@loop/runtime/state/server";
import { TriangleAlertIcon } from "lucide-react";

import type { EnvironmentPresentation } from "~/state/environments";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
} from "~/versionSkew";
import { ServerUpdateAction, ServerUpdateProgress } from "../../ServerUpdateAction";
import { ScrollArea } from "../../ui/scroll-area";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { type AccessSectionPresentation, accessRowClassName } from "./accessRows";
import { AuthorizedClientsHeaderAction } from "./AuthorizedClientsHeaderAction";
import { CloudLinkRow } from "./CloudLinkRows";
import {
  DisabledNetworkAccessRow,
  EndpointRows,
  NetworkAccessRow,
  NetworkExposureConfirmDialog,
} from "./NetworkAccessRows";
import { PairingClientsList } from "./PairingClientsList";
import {
  TailscaleRow,
  TailscaleServeDisableDialog,
  TailscaleServeSetupDialog,
} from "./TailscaleServeControls";
import type { AdvertisedEndpoints } from "./useAdvertisedEndpoints";
import type { DesktopAccessManagement } from "./useDesktopAccessManagement";
import type { DesktopNetworkExposure } from "./useDesktopNetworkExposure";
import type { TailscaleServe } from "./useTailscaleServe";
import type { WslBackend } from "./useWslBackend";
import { WslBackendRows } from "./WslBackendRows";
import { WslChangeConfirmDialog } from "./WslChangeConfirmDialog";

export type LocalBackendAdminProps = {
  readonly hasDesktopBridge: boolean;
  readonly canManageLocalBackend: boolean;
  readonly canManageRelay: boolean;
  readonly currentAuthPolicy: string | null;
  readonly primaryEnvironment: EnvironmentPresentation | null;
  readonly primaryServerUpdateState: ServerUpdateState;
  readonly exposure: DesktopNetworkExposure;
  readonly endpoints: AdvertisedEndpoints;
  readonly tailscale: TailscaleServe;
  readonly wsl: WslBackend;
  readonly access: DesktopAccessManagement;
};

function primaryUpdateTitle(state: ServerUpdateState): string {
  return state.status === "failed"
    ? "Update failed"
    : state.status === "running"
      ? "Updating server"
      : "Version drift";
}

function PrimaryServerVersionRow({
  primaryEnvironment,
  primaryServerUpdateState,
}: Pick<LocalBackendAdminProps, "primaryEnvironment" | "primaryServerUpdateState">) {
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const primaryServerConfig = primaryEnvironment?.serverConfig ?? null;
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig);
  if (!primaryVersionMismatch && primaryServerUpdateState.status === "idle") return null;
  return (
    <SettingsRow
      title={primaryUpdateTitle(primaryServerUpdateState)}
      description={
        primaryServerUpdateState.status !== "idle" ? (
          <ServerUpdateProgress
            fromVersion={primaryServerUpdateState.fromVersion}
            state={primaryServerUpdateState}
          />
        ) : primaryVersionMismatch ? (
          <span className="flex items-center gap-1 text-warning">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            Client {primaryVersionMismatch.clientVersion}, server{" "}
            {primaryVersionMismatch.serverVersion}. Sync them if RPC calls or reconnects fail.
          </span>
        ) : null
      }
      control={
        primaryVersionMismatch &&
        primaryEnvironmentId !== null &&
        primaryServerUpdateState.status !== "running" ? (
          <ServerUpdateAction
            environmentId={primaryEnvironmentId}
            serverLabel={primaryEnvironment?.label ?? "this server"}
            selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
            targetVersion={primaryVersionMismatch.clientVersion}
            {...(primaryServerUpdateState.status === "failed" ? { label: "Retry update" } : {})}
          />
        ) : undefined
      }
    />
  );
}

function ThisEnvironmentSection(props: LocalBackendAdminProps) {
  const { exposure, endpoints, tailscale, canManageRelay } = props;
  return (
    <SettingsSection title="This environment">
      <PrimaryServerVersionRow {...props} />
      {props.hasDesktopBridge ? (
        <>
          <NetworkAccessRow exposure={exposure} endpoints={endpoints} />
          <EndpointRows presentation="endpoint-rail" endpoints={endpoints} tailscale={tailscale} />
          <TailscaleRow
            tailscaleHttpsEndpoint={endpoints.tailscaleHttpsEndpoint}
            tailscale={tailscale}
          />
          <WslBackendRows wsl={props.wsl} canManageLocalBackend={props.canManageLocalBackend} />
          <CloudLinkRow canManageRelay={canManageRelay} />
        </>
      ) : (
        <>
          <DisabledNetworkAccessRow
            currentAuthPolicy={props.currentAuthPolicy}
            isNetworkAccessible={exposure.isNetworkAccessible}
          />
          <CloudLinkRow canManageRelay={canManageRelay} />
        </>
      )}
    </SettingsSection>
  );
}

function AuthorizedClients({
  presentation,
  access,
  exposure,
  endpoints,
}: Pick<LocalBackendAdminProps, "access" | "exposure" | "endpoints"> & {
  readonly presentation: AccessSectionPresentation;
}) {
  return (
    <>
      {access.error ? (
        <div className={accessRowClassName(presentation)}>
          <p className="text-xs text-destructive">{access.error}</p>
        </div>
      ) : null}
      <PairingClientsList
        endpointUrl={exposure.serverExposureState?.endpointUrl}
        endpoints={endpoints.visibleEndpoints}
        defaultEndpointKey={endpoints.defaultEndpointKey}
        presentation={presentation}
        isLoading={access.isLoading}
        pairingLinks={access.pairingLinks}
        clientSessions={access.clientSessions}
        revokingPairingLinkId={access.revokingPairingLinkId}
        revokingClientSessionId={access.revokingClientSessionId}
        onRevokePairingLink={access.handleRevokePairingLink}
        onRevokeClientSession={access.handleRevokeClientSession}
      />
    </>
  );
}

function AuthorizedClientsSection(props: LocalBackendAdminProps) {
  const { access } = props;
  return (
    <SettingsSection
      title="Authorized clients"
      headerAction={
        <AuthorizedClientsHeaderAction
          clientSessions={access.clientSessions}
          isRevokingOtherClients={access.isRevokingOtherClients}
          onRevokeOtherClients={access.handleRevokeOtherClients}
        />
      }
    >
      <ScrollArea
        scrollFade
        className="max-h-[22.5rem]"
        data-testid="authorized-clients-scroll-area"
      >
        <AuthorizedClients presentation="current" {...props} />
      </ScrollArea>
    </SettingsSection>
  );
}

/** Network exposure, Tailscale, WSL and pairing management for the app's own backend. */
export function LocalBackendAdmin(props: LocalBackendAdminProps) {
  return (
    <>
      <ThisEnvironmentSection {...props} />

      {props.endpoints.isRemotelyReachable ? <AuthorizedClientsSection {...props} /> : null}
      <NetworkExposureConfirmDialog exposure={props.exposure} />
      <WslChangeConfirmDialog wsl={props.wsl} />
      <TailscaleServeDisableDialog tailscale={props.tailscale} />
      <TailscaleServeSetupDialog tailscale={props.tailscale} />
    </>
  );
}

/** Shown instead when the session lacks access:write on this backend. */
export function LocalBackendAdminUnavailable({ canManageRelay }: { canManageRelay: boolean }) {
  return (
    <SettingsSection title="This environment">
      <SettingsRow
        title="Administrative access"
        description="Pairing links and client-session management require the access:write scope for this backend."
      />
      <CloudLinkRow canManageRelay={canManageRelay} />
    </SettingsSection>
  );
}
