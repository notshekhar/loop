import type { AdvertisedEndpoint, DesktopBridge } from "@loop/contracts";
import { useCallback, useMemo, useState } from "react";

import { refreshDesktopNetworkAccessState } from "~/state/desktopNetworkAccess";
import { errorMessage, showErrorToast } from "./connectionToasts";

const DEFAULT_TAILSCALE_SERVE_PORT = 443;

function isValidServePort(trimmedInput: string, parsedPort: number): boolean {
  return (
    /^\d+$/u.test(trimmedInput) &&
    Number.isInteger(parsedPort) &&
    parsedPort >= 1 &&
    parsedPort <= 65_535
  );
}

function servePortBaseUrl(
  endpoint: AdvertisedEndpoint | null,
  isPortValid: boolean,
  port: number,
): string | null {
  if (!endpoint) return null;
  if (!isPortValid) return endpoint.httpBaseUrl;
  if (port === DEFAULT_TAILSCALE_SERVE_PORT) {
    return endpoint.httpBaseUrl;
  }
  try {
    const url = new URL(endpoint.httpBaseUrl);
    url.port = String(port);
    return url.toString().replace(/\/$/u, "");
  } catch {
    return endpoint.httpBaseUrl;
  }
}

/** The setup dialog's port field and the HTTPS URL it would produce. */
function useTailscaleServePort(pendingEndpoint: AdvertisedEndpoint | null) {
  const [portInput, setPortInput] = useState(String(DEFAULT_TAILSCALE_SERVE_PORT));
  const trimmedPortInput = portInput.trim();
  const parsedPort = Number(trimmedPortInput);
  const isPortValid = isValidServePort(trimmedPortInput, parsedPort);
  const pendingBaseUrl = useMemo(
    () => servePortBaseUrl(pendingEndpoint, isPortValid, parsedPort),
    [isPortValid, parsedPort, pendingEndpoint],
  );
  return { portInput, setPortInput, parsedPort, isPortValid, pendingBaseUrl };
}

/** Restarts the backend with Tailscale Serve on or off, reporting failures as exposure errors. */
function useTailscaleServeMutation(setExposureMutationError: (message: string | null) => void) {
  const [isUpdating, setIsUpdating] = useState(false);
  const runServeChange = useCallback(
    async (bridge: DesktopBridge, enabled: boolean, servePort: number, onDone: () => void) => {
      setIsUpdating(true);
      setExposureMutationError(null);
      try {
        await bridge.setTailscaleServeEnabled({ enabled, port: servePort });
        refreshDesktopNetworkAccessState();
        onDone();
      } catch (error) {
        const message = enabled
          ? errorMessage(error, "Failed to configure Tailscale HTTPS.")
          : errorMessage(error, "Failed to disable Tailscale HTTPS.");
        setExposureMutationError(message);
        showErrorToast(
          enabled ? "Could not set up Tailscale HTTPS" : "Could not disable Tailscale HTTPS",
          message,
        );
      } finally {
        setIsUpdating(false);
      }
    },
    [setExposureMutationError],
  );
  return { isUpdating, runServeChange };
}

/** Tailscale Serve setup/disable: dialogs, port and the restarting mutations. */
export function useTailscaleServe(input: {
  readonly desktopBridge: DesktopBridge | undefined;
  readonly currentServePort: number | null | undefined;
  readonly setExposureMutationError: (message: string | null) => void;
}) {
  const { desktopBridge, currentServePort, setExposureMutationError } = input;
  const { isUpdating, runServeChange } = useTailscaleServeMutation(setExposureMutationError);
  const [pendingEndpoint, setPendingEndpoint] = useState<AdvertisedEndpoint | null>(null);
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const port = useTailscaleServePort(pendingEndpoint);
  const { isPortValid, parsedPort, setPortInput } = port;

  const handleConfirmSetup = useCallback(async () => {
    if (!desktopBridge) return;
    if (!isPortValid) return;
    await runServeChange(desktopBridge, true, parsedPort, () => setPendingEndpoint(null));
  }, [desktopBridge, isPortValid, parsedPort, runServeChange]);

  const handleStartSetup = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setPortInput(String(currentServePort ?? DEFAULT_TAILSCALE_SERVE_PORT));
      setPendingEndpoint(endpoint);
    },
    [currentServePort, setPortInput],
  );

  const handleConfirmDisable = useCallback(async () => {
    if (!desktopBridge) return;
    await runServeChange(
      desktopBridge,
      false,
      currentServePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
      () => setDisableDialogOpen(false),
    );
  }, [currentServePort, desktopBridge, runServeChange]);

  const handleStartDisable = useCallback((_endpoint: AdvertisedEndpoint) => {
    setDisableDialogOpen(true);
  }, []);

  return {
    isUpdating,
    pendingEndpoint,
    setPendingEndpoint,
    disableDialogOpen,
    setDisableDialogOpen,
    ...port,
    handleConfirmSetup,
    handleStartSetup,
    handleConfirmDisable,
    handleStartDisable,
  };
}

export type TailscaleServe = ReturnType<typeof useTailscaleServe>;
