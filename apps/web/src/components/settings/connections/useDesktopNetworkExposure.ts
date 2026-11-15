import type {
  AdvertisedEndpoint,
  DesktopBridge,
  DesktopServerExposureState,
} from "@loop/contracts";
import { useCallback, useState } from "react";

import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { useEnvironmentQuery } from "~/state/query";
import { errorMessage, showErrorToast } from "./connectionToasts";

const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

type ServerExposureMode = DesktopServerExposureState["mode"];

/** The desktop's local-only vs network-accessible switch and its restart confirmation. */
export function useDesktopNetworkExposure(input: {
  readonly desktopBridge: DesktopBridge | undefined;
  readonly canManageLocalBackend: boolean;
  readonly currentAuthPolicy: string | null;
}) {
  const { desktopBridge, canManageLocalBackend, currentAuthPolicy } = input;
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<ServerExposureMode | null>(null);
  const desktopNetworkAccess = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopNetworkAccessStateAtom : null,
  );
  const serverExposureState = desktopNetworkAccess.data?.serverExposureState ?? null;

  const handleServerExposureChange = useCallback(
    async (checked: boolean) => {
      if (!desktopBridge) return;
      setIsUpdating(true);
      setMutationError(null);
      try {
        await desktopBridge.setServerExposureMode(checked ? "network-accessible" : "local-only");
        refreshDesktopNetworkAccessState();
        setIsDialogOpen(false);
        setIsUpdating(false);
      } catch (error) {
        const message = errorMessage(error, "Failed to update network exposure.");
        setIsDialogOpen(false);
        setMutationError(message);
        showErrorToast("Could not update network access", message);
        setIsUpdating(false);
      }
    },
    [desktopBridge],
  );

  const handleConfirmChange = useCallback(() => {
    if (pendingMode === null) return;
    const checked = pendingMode === "network-accessible";
    void handleServerExposureChange(checked);
  }, [handleServerExposureChange, pendingMode]);

  const requestModeChange = (checked: boolean) => {
    setPendingMode(checked ? "network-accessible" : "local-only");
    setIsDialogOpen(true);
  };

  return {
    serverExposureState,
    advertisedEndpoints:
      desktopNetworkAccess.data?.advertisedEndpoints ?? EMPTY_ADVERTISED_ENDPOINTS,
    error: mutationError ?? desktopNetworkAccess.error,
    setMutationError,
    isNetworkAccessible: desktopBridge
      ? serverExposureState?.mode === "network-accessible"
      : currentAuthPolicy === "remote-reachable",
    isUpdating,
    isDialogOpen,
    setIsDialogOpen,
    pendingMode,
    setPendingMode,
    requestModeChange,
    handleConfirmChange,
  };
}

export type DesktopNetworkExposure = ReturnType<typeof useDesktopNetworkExposure>;
