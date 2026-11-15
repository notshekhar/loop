import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthRelayWriteScope,
  type EnvironmentId,
} from "@loop/contracts";

import { usePrimarySessionState } from "~/environments/primary";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { LocalBackendAdmin, LocalBackendAdminUnavailable } from "./connections/LocalBackendAdmin";
import { RemoteEnvironmentsSection } from "./connections/RemoteEnvironmentsSection";
import { useAddBackendForm, useAddSavedBackend } from "./connections/useAddBackendForm";
import { useAdvertisedEndpoints } from "./connections/useAdvertisedEndpoints";
import { useDesktopAccessManagement } from "./connections/useDesktopAccessManagement";
import { useDesktopNetworkExposure } from "./connections/useDesktopNetworkExposure";
import { useSavedBackendActions } from "./connections/useSavedBackendActions";
import { useSavedEnvironments } from "./connections/useSavedEnvironments";
import { useSshHosts } from "./connections/useSshHosts";
import { useTailscaleServe } from "./connections/useTailscaleServe";
import { useWslBackend } from "./connections/useWslBackend";
import { SettingsPageContainer } from "./settingsLayout";

/**
 * The "This environment" controls — network exposure, Tailscale, WSL, pairing
 * links and authorized clients for the app's own backend — are upstream's, and
 * loop's desktop has nothing behind them: another device reaches this machine
 * through `loop serve` or `/rc`, which print their own address and code. Off
 * until the desktop can host, so the page is only what works: adding other
 * computers' loops.
 */
const SHOWS_LOCAL_BACKEND_ADMIN = false;

/** Scopes and auth policy of the session this page is managing the backend with. */
function useCurrentSessionAccess(hasDesktopBridge: boolean) {
  const primarySessionState = usePrimarySessionState();
  const currentSessionScopes = hasDesktopBridge
    ? AuthAdministrativeScopes
    : primarySessionState.data?.authenticated
      ? (primarySessionState.data.scopes ?? null)
      : null;
  return {
    currentAuthPolicy: hasDesktopBridge ? null : (primarySessionState.data?.auth.policy ?? null),
    canManageLocalBackend: currentSessionScopes?.includes(AuthAccessWriteScope) ?? false,
    canManageRelay: currentSessionScopes?.includes(AuthRelayWriteScope) ?? false,
  };
}

/** Everything the (currently hidden) local-backend admin sections read and drive. */
function useLocalBackendAdmin(input: {
  readonly desktopBridge: Window["desktopBridge"];
  readonly canManageLocalBackend: boolean;
  readonly currentAuthPolicy: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: ReturnType<typeof useEnvironments>["environments"];
}) {
  const { desktopBridge, canManageLocalBackend, currentAuthPolicy, primaryEnvironmentId } = input;
  const access = useDesktopAccessManagement({ canManageLocalBackend, primaryEnvironmentId });
  const exposure = useDesktopNetworkExposure({
    desktopBridge,
    canManageLocalBackend,
    currentAuthPolicy,
  });
  const tailscale = useTailscaleServe({
    desktopBridge,
    currentServePort: exposure.serverExposureState?.tailscaleServePort,
    setExposureMutationError: exposure.setMutationError,
  });
  const endpoints = useAdvertisedEndpoints({
    advertisedEndpoints: exposure.advertisedEndpoints,
    isNetworkAccessible: exposure.isNetworkAccessible,
  });
  const wsl = useWslBackend({
    desktopBridge,
    canManageLocalBackend,
    environments: input.environments,
  });
  return { access, exposure, tailscale, endpoints, wsl };
}

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const { currentAuthPolicy, canManageLocalBackend, canManageRelay } =
    useCurrentSessionAccess(Boolean(desktopBridge));
  const { savedEnvironments, savedDesktopSshEnvironmentsByAlias, savedDesktopSshEnvironmentKeys } =
    useSavedEnvironments(environments);
  const primaryServerUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(primaryEnvironmentId),
  );
  const localBackendAdmin = useLocalBackendAdmin({
    desktopBridge,
    canManageLocalBackend,
    currentAuthPolicy,
    primaryEnvironmentId,
    environments,
  });
  const addBackendForm = useAddBackendForm();
  const sshHosts = useSshHosts({
    desktopBridge,
    form: addBackendForm,
    savedDesktopSshEnvironmentKeys,
    savedDesktopSshEnvironmentsByAlias,
  });
  const handleAddSavedBackend = useAddSavedBackend(addBackendForm);
  const savedBackendActions = useSavedBackendActions(addBackendForm.setError);

  return (
    <SettingsPageContainer>
      {SHOWS_LOCAL_BACKEND_ADMIN && canManageLocalBackend ? (
        <LocalBackendAdmin
          hasDesktopBridge={Boolean(desktopBridge)}
          canManageLocalBackend={canManageLocalBackend}
          canManageRelay={canManageRelay}
          currentAuthPolicy={currentAuthPolicy}
          primaryEnvironment={primaryEnvironment}
          primaryServerUpdateState={primaryServerUpdateState}
          {...localBackendAdmin}
        />
      ) : SHOWS_LOCAL_BACKEND_ADMIN ? (
        <LocalBackendAdminUnavailable canManageRelay={canManageRelay} />
      ) : null}

      <RemoteEnvironmentsSection
        primaryEnvironmentId={primaryEnvironmentId}
        savedEnvironments={savedEnvironments}
        addBackendForm={addBackendForm}
        sshHosts={sshHosts}
        canUseSsh={Boolean(desktopBridge)}
        onAddBackend={() => void handleAddSavedBackend()}
        savedBackendActions={savedBackendActions}
      />
    </SettingsPageContainer>
  );
}
