import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@loop/contracts";
import { connectionStatusText } from "@loop/runtime/connection";
import type { ServerUpdateState } from "@loop/runtime/state/server";
import * as Option from "effect/Option";
import { TriangleAlertIcon } from "lucide-react";
import { useCallback } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import type { EnvironmentPresentation } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
} from "~/versionSkew";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { ConnectionStatusDot } from "../../ConnectionStatusDot";
import { ServerUpdateAction, ServerUpdateProgress } from "../../ServerUpdateAction";
import { Button } from "../../ui/button";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../itemRows";
import { formatDesktopSshTarget } from "./sshTargets";

type ConnectionPhase = EnvironmentPresentation["connection"]["phase"];
type VersionMismatch = NonNullable<ReturnType<typeof resolveServerConfigVersionMismatch>>;

function connectionDotClassName(connectionState: ConnectionPhase): string {
  return connectionState === "connected"
    ? "bg-success"
    : connectionState === "connecting" || connectionState === "reconnecting"
      ? "bg-warning"
      : connectionState === "error"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
}

function savedBackendMetadataBits(environment: EnvironmentPresentation): Array<string> {
  const sshTarget =
    environment.entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(environment.entry.profile) &&
    environment.entry.profile.value._tag === "SshConnectionProfile"
      ? environment.entry.profile.value.target
      : null;
  return [
    sshTarget ? `SSH ${formatDesktopSshTarget(sshTarget)}` : null,
    environment.relayManaged ? "Loop Connect" : null,
  ].filter((value): value is string => value !== null);
}

function useCopyTraceId() {
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "trace ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: "Trace ID copied",
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy trace ID",
          description: error.message,
        }),
      );
    },
  });
  return useCallback(
    (traceId: string) => {
      copyTraceIdToClipboard(traceId, { traceId });
    },
    [copyTraceIdToClipboard],
  );
}

function SavedBackendStatusLines({
  environment,
  serverUpdateState,
  versionMismatch,
}: {
  environment: EnvironmentPresentation;
  serverUpdateState: ServerUpdateState;
  versionMismatch: VersionMismatch | null;
}) {
  const copyTraceId = useCopyTraceId();
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  const errorTraceId = environment.connection.traceId;
  return (
    <>
      {serverUpdateState.status !== "idle" ? (
        <div className="max-w-md">
          <ServerUpdateProgress
            fromVersion={serverUpdateState.fromVersion}
            state={serverUpdateState}
          />
        </div>
      ) : versionMismatch ? (
        <p className="flex items-center gap-1 text-warning text-xs">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          Version drift: client {versionMismatch.clientVersion}, server{" "}
          {versionMismatch.serverVersion}.
        </p>
      ) : null}
      {environment.connection.error && !resumingServerUpdate ? (
        <p className="flex min-w-0 items-center gap-2 text-destructive text-xs">
          <span className="truncate">{connectionStatusText(environment.connection)}</span>
          {errorTraceId ? (
            <button
              type="button"
              className="shrink-0 underline underline-offset-2"
              onClick={() => copyTraceId(errorTraceId)}
            >
              Copy trace ID
            </button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  removingEnvironmentId: EnvironmentId | null;
  onConnect: (environmentId: EnvironmentId) => void;
  onRemove: (environmentId: EnvironmentId) => void;
};

function SavedBackendConnectButtons({
  environment,
  removingEnvironmentId,
  onConnect,
  onRemove,
}: SavedBackendListRowProps) {
  const environmentId = environment.environmentId;
  const connectionState = environment.connection.phase;
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  return (
    <>
      {!isConnected ? (
        <Button
          size="xs"
          variant="outline"
          disabled={removingEnvironmentId === environmentId}
          onClick={() => void onRemove(environmentId)}
        >
          {removingEnvironmentId === environmentId ? "Removing…" : "Remove"}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        disabled={isConnecting || removingEnvironmentId === environmentId}
        onClick={() => void (isConnected ? onRemove(environmentId) : onConnect(environmentId))}
      >
        {isConnected
          ? removingEnvironmentId === environmentId
            ? "Disconnecting…"
            : "Disconnect"
          : isConnecting
            ? "Connecting…"
            : "Connect"}
      </Button>
    </>
  );
}

function ManagedWslButton() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="xs" variant="outline" disabled>
            Managed above
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        The WSL backend is managed by the WSL setting above — turn it on or off there.
      </TooltipPopup>
    </Tooltip>
  );
}

export function SavedBackendListRow(props: SavedBackendListRowProps) {
  const { environment } = props;
  const environmentId = environment.environmentId;
  const connectionState = environment.connection.phase;
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const metadataBits = savedBackendMetadataBits(environment);

  // The WSL backend is a desktop-managed local backend (it surfaces as a bearer
  // environment whose connection id is prefixed "local:"), not a remote
  // environment you connect to or remove here — its lifecycle is driven by the
  // WSL on/off + distro picker on this page.
  const isWslEnvironment = isDesktopLocalConnectionTarget(environment.entry.target);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={connectionStatusText(environment.connection)}
              dotClassName={connectionDotClassName(connectionState)}
              pingClassName={
                connectionState === "connecting" || connectionState === "reconnecting"
                  ? "bg-warning/60 duration-2000"
                  : null
              }
            />
            <h3 className="text-sm font-medium text-foreground">{environment.label}</h3>
          </div>
          {metadataBits.length > 0 ? (
            <p className="text-xs text-muted-foreground">{metadataBits.join(" · ")}</p>
          ) : null}
          <SavedBackendStatusLines
            environment={environment}
            serverUpdateState={serverUpdateState}
            versionMismatch={versionMismatch}
          />
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {versionMismatch &&
          (serverUpdateState.status === "idle" || serverUpdateState.status === "failed") ? (
            <ServerUpdateAction
              environmentId={environmentId}
              serverLabel={`${environment.label} server`}
              selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
              targetVersion={versionMismatch.clientVersion}
              label={serverUpdateState.status === "failed" ? "Retry update" : "Update server"}
            />
          ) : null}
          {isWslEnvironment ? <ManagedWslButton /> : <SavedBackendConnectButtons {...props} />}
        </div>
      </div>
    </div>
  );
}
