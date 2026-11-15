import type { DesktopSshEnvironmentTarget } from "@loop/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import { useCallback, useState } from "react";

import {
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { useAtomCommand } from "../../../state/use-atom-command";
import { toastManager } from "../../ui/toast";
import { errorMessage, showErrorToast } from "./connectionToasts";
import { parsePairingUrlFields, parseRemotePairingFields } from "./remotePairingInput";
import { formatDesktopSshConnectionError, parseManualDesktopSshTarget } from "./sshTargets";

export type AddBackendMode = "remote" | "ssh";

/** Field state of the "Add a host" dialog, shared by the remote and SSH modes. */
export function useAddBackendForm() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<AddBackendMode>("remote");
  const [host, setHost] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const clearSshFields = useCallback(() => {
    setSshHost("");
    setSshUsername("");
    setSshPort("");
  }, []);

  const handleHostChange = useCallback((value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (parsedPairingUrl) {
      setHost(parsedPairingUrl.host);
      setPairingCode(parsedPairingUrl.pairingCode);
      return;
    }
    setHost(value);
  }, []);

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setError(null);
    }
  };

  return {
    dialogOpen,
    setDialogOpen,
    handleDialogOpenChange,
    mode,
    setMode,
    host,
    setHost,
    pairingCode,
    setPairingCode,
    sshHost,
    setSshHost,
    sshUsername,
    setSshUsername,
    sshPort,
    setSshPort,
    error,
    setError,
    isAdding,
    setIsAdding,
    clearSshFields,
    handleHostChange,
  };
}

export type AddBackendForm = ReturnType<typeof useAddBackendForm>;

type ConnectSshEnvironment = ReturnType<typeof useConnectSshEnvironmentCommand>;
type ConnectPairing = ReturnType<typeof useConnectPairingCommand>;

export function useConnectSshEnvironmentCommand() {
  return useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
}

function useConnectPairingCommand() {
  return useAtomCommand(connectPairingAtom, { reportFailure: false });
}

type AddedBackend = { readonly title: string; readonly description: string };
type SetError = (message: string | null) => void;

/** Returns the success toast to show, or null when the form already shows the failure. */
async function addSshBackend(
  fields: { readonly sshHost: string; readonly sshUsername: string; readonly sshPort: string },
  setError: SetError,
  connectSshEnvironment: ConnectSshEnvironment,
): Promise<AddedBackend | null> {
  let target: DesktopSshEnvironmentTarget;
  try {
    target = parseManualDesktopSshTarget({
      host: fields.sshHost,
      username: fields.sshUsername,
      port: fields.sshPort,
    });
  } catch (error) {
    setError(formatDesktopSshConnectionError(error));
    return null;
  }

  const result = await connectSshEnvironment({ target, label: "" });
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      setError(formatDesktopSshConnectionError(squashAtomCommandFailure(result)));
    }
    return null;
  }
  return {
    title: "Environment connected",
    description: `${target.alias} is ready over an SSH-managed tunnel.`,
  };
}

function reportAddBackendFailure(setError: SetError, error: unknown) {
  const message = errorMessage(error, "Failed to add backend.");
  setError(message);
  showErrorToast("Could not add backend", message);
}

async function addRemoteBackend(
  fields: { readonly host: string; readonly pairingCode: string },
  setError: SetError,
  connectPairing: ConnectPairing,
): Promise<AddedBackend | null> {
  let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;
  try {
    remotePairingInput = parseRemotePairingFields(fields);
  } catch (error) {
    reportAddBackendFailure(setError, error);
    return null;
  }

  const result = await connectPairing(remotePairingInput);
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      reportAddBackendFailure(setError, squashAtomCommandFailure(result));
    }
    return null;
  }
  return {
    title: "Backend added",
    description: "The environment is saved and will reconnect on app startup.",
  };
}

/** Submits the "Add host" form in whichever mode is selected. */
export function useAddSavedBackend(form: AddBackendForm) {
  const connectPairing = useConnectPairingCommand();
  const connectSshEnvironment = useConnectSshEnvironmentCommand();
  const { mode, host, pairingCode, sshHost, sshUsername, sshPort } = form;
  const { setIsAdding, setError, setHost, setPairingCode, clearSshFields, setDialogOpen } = form;
  return useCallback(async () => {
    setIsAdding(true);
    setError(null);
    const added =
      mode === "ssh"
        ? await addSshBackend({ sshHost, sshUsername, sshPort }, setError, connectSshEnvironment)
        : await addRemoteBackend({ host, pairingCode }, setError, connectPairing);
    if (added) {
      setHost("");
      setPairingCode("");
      clearSshFields();
      setDialogOpen(false);
      toastManager.add({ type: "success", ...added });
    }
    setIsAdding(false);
  }, [
    connectPairing,
    connectSshEnvironment,
    host,
    mode,
    pairingCode,
    sshHost,
    sshPort,
    sshUsername,
  ]);
}
