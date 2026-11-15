import type { AdvertisedEndpoint } from "@loop/contracts";
import { useCallback, useMemo, useState } from "react";

import { useUiStateStore } from "~/uiStateStore";
import {
  endpointDefaultPreferenceKey,
  isTailscaleHttpsEndpoint,
  selectPairingEndpoint,
} from "./advertisedEndpoints";

/**
 * Which advertised endpoints are shown, and which one pairing links default
 * to. Tailscale HTTPS is listed separately from the network endpoints because
 * it stays reachable even when network access is off.
 */
export function useAdvertisedEndpoints(input: {
  readonly advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly isNetworkAccessible: boolean;
}) {
  const { advertisedEndpoints, isNetworkAccessible } = input;
  const [isListExpanded, setIsListExpanded] = useState(false);
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  );
  const tailscaleHttpsEndpoint = useMemo(
    () => advertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null,
    [advertisedEndpoints],
  );
  const visibleNetworkEndpoints = useMemo(
    () =>
      isNetworkAccessible
        ? advertisedEndpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
        : [],
    [advertisedEndpoints, isNetworkAccessible],
  );
  const visibleEndpoints = useMemo(
    () =>
      tailscaleHttpsEndpoint
        ? [...visibleNetworkEndpoints, tailscaleHttpsEndpoint]
        : visibleNetworkEndpoints,
    [tailscaleHttpsEndpoint, visibleNetworkEndpoints],
  );
  const defaultNetworkEndpoint = useMemo(
    () => selectPairingEndpoint(visibleNetworkEndpoints, defaultAdvertisedEndpointKey),
    [defaultAdvertisedEndpointKey, visibleNetworkEndpoints],
  );
  const defaultEndpoint = useMemo(
    () =>
      defaultNetworkEndpoint ??
      selectPairingEndpoint(
        tailscaleHttpsEndpoint ? [tailscaleHttpsEndpoint] : [],
        defaultAdvertisedEndpointKey,
      ),
    [defaultAdvertisedEndpointKey, defaultNetworkEndpoint, tailscaleHttpsEndpoint],
  );
  const handleSetDefault = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
    },
    [setDefaultAdvertisedEndpointKey],
  );
  return {
    isListExpanded,
    toggleListExpanded: () => setIsListExpanded((expanded) => !expanded),
    tailscaleHttpsEndpoint,
    visibleNetworkEndpoints,
    visibleEndpoints,
    defaultNetworkEndpoint,
    defaultEndpointKey: defaultEndpoint ? endpointDefaultPreferenceKey(defaultEndpoint) : null,
    isRemotelyReachable: isNetworkAccessible || tailscaleHttpsEndpoint?.status === "available",
    handleSetDefault,
  };
}

export type AdvertisedEndpoints = ReturnType<typeof useAdvertisedEndpoints>;
