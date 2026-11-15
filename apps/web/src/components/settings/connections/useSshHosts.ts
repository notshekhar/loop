import type {
  DesktopBridge,
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentTarget,
} from "@loop/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import { useCallback, useMemo, useState } from "react";

import { desktopSshHostsStateAtom } from "~/state/desktopSshHosts";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { toastManager } from "../../ui/toast";
import { type AddBackendForm, useConnectSshEnvironmentCommand } from "./useAddBackendForm";
import { formatDesktopSshConnectionError, formatDesktopSshTarget } from "./sshTargets";

const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];

/** Hosts from SSH config / known hosts, loaded only while the SSH tab of the dialog is open. */
function useDiscoveredSshHosts(input: {
  readonly desktopBridge: DesktopBridge | undefined;
  readonly form: AddBackendForm;
  readonly savedDesktopSshEnvironmentKeys: ReadonlySet<string>;
}) {
  const { desktopBridge, form, savedDesktopSshEnvironmentKeys } = input;
  const desktopSshHosts = useEnvironmentQuery(
    desktopBridge && form.dialogOpen && form.mode === "ssh" ? desktopSshHostsStateAtom : null,
  );
  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  const unsavedHosts = useMemo(
    () =>
      discoveredSshHosts.filter((target) => {
        const address = formatDesktopSshTarget(target);
        return (
          !savedDesktopSshEnvironmentKeys.has(target.alias) &&
          !savedDesktopSshEnvironmentKeys.has(address)
        );
      }),
    [discoveredSshHosts, savedDesktopSshEnvironmentKeys],
  );
  return {
    unsavedHosts,
    hasLoaded: desktopSshHosts.data !== null || desktopSshHosts.error !== null,
    isLoading: desktopSshHosts.isPending,
    loadError: desktopSshHosts.error,
    refresh: desktopSshHosts.refresh,
  };
}

/** One-click connect for a discovered SSH host. */
function useConnectSshHost(input: {
  readonly form: AddBackendForm;
  readonly savedDesktopSshEnvironmentsByAlias: Record<string, EnvironmentPresentation>;
  readonly setSshConnectionError: (message: string | null) => void;
}) {
  const { form, savedDesktopSshEnvironmentsByAlias, setSshConnectionError } = input;
  const connectSshEnvironment = useConnectSshEnvironmentCommand();
  const [connectingHostAlias, setConnectingHostAlias] = useState<string | null>(null);
  const { mode: savedBackendMode, setError, clearSshFields, setDialogOpen } = form;

  const handleConnectSshHost = useCallback(
    async (target: DesktopSshEnvironmentTarget, label?: string) => {
      setConnectingHostAlias(target.alias);
      if (savedBackendMode === "ssh") {
        setError(null);
      } else {
        setSshConnectionError(null);
      }
      const result = await connectSshEnvironment({
        target,
        ...(label === undefined ? {} : { label }),
      });
      setConnectingHostAlias(null);
      if (result._tag === "Success") {
        clearSshFields();
        setDialogOpen(false);
        toastManager.add({
          type: "success",
          title: savedDesktopSshEnvironmentsByAlias[target.alias]
            ? "Environment reconnected"
            : "Environment connected",
          description: `${label?.trim() || target.alias} is ready over an SSH-managed tunnel.`,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const message = formatDesktopSshConnectionError(squashAtomCommandFailure(result));
        if (savedBackendMode === "ssh") {
          setError(message);
        } else {
          setSshConnectionError(message);
        }
      }
    },
    [connectSshEnvironment, savedBackendMode, savedDesktopSshEnvironmentsByAlias],
  );
  return { connectingHostAlias, handleConnectSshHost };
}

/** Discovered SSH hosts and connecting to them from the "Add host" dialog. */
export function useSshHosts(input: {
  readonly desktopBridge: DesktopBridge | undefined;
  readonly form: AddBackendForm;
  readonly savedDesktopSshEnvironmentKeys: ReadonlySet<string>;
  readonly savedDesktopSshEnvironmentsByAlias: Record<string, EnvironmentPresentation>;
}) {
  const [sshConnectionError, setSshConnectionError] = useState<string | null>(null);
  const discovered = useDiscoveredSshHosts(input);
  const connect = useConnectSshHost({ ...input, setSshConnectionError });
  return {
    ...discovered,
    ...connect,
    error: sshConnectionError ?? discovered.loadError,
  };
}

export type SshHosts = ReturnType<typeof useSshHosts>;
