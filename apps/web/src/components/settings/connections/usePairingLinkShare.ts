import type { AdvertisedEndpoint } from "@loop/contracts";
import { useCallback, useMemo } from "react";

import { isLoopbackHostname, type ServerPairingLinkRecord } from "~/environments/primary";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "../pairingUrls";
import {
  endpointDefaultPreferenceKey,
  isHostedAppPairingUrl,
  resolveAdvertisedEndpointPairingUrl,
  resolveCurrentOriginPairingUrl,
  selectPairingEndpoint,
} from "./advertisedEndpoints";

export type PairingCopyKind = "code" | "hosted-link" | "link";

export type EndpointCopyOption = {
  readonly key: string;
  readonly label: string;
  readonly url: string;
  readonly detail: string;
};

function buildEndpointCopyOptions(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  credential: string,
): Array<EndpointCopyOption> {
  const options: Array<EndpointCopyOption> = [];
  for (const endpoint of endpoints) {
    if (endpoint.status === "unavailable") {
      continue;
    }
    const url = resolveAdvertisedEndpointPairingUrl(endpoint, credential);
    options.push({
      key: endpointDefaultPreferenceKey(endpoint),
      label: endpoint.label,
      url,
      detail: isHostedAppPairingUrl(url) ? "Hosted app link" : "Backend pairing URL",
    });
  }
  return options;
}

export function usePairingLinkUrls(input: {
  readonly pairingLink: ServerPairingLinkRecord;
  readonly endpointUrl: string | null | undefined;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
}) {
  const { pairingLink, endpointUrl, endpoints, defaultEndpointKey } = input;
  const currentOriginPairingUrl = useMemo(
    () => resolveCurrentOriginPairingUrl(pairingLink.credential),
    [pairingLink.credential],
  );
  const hostedPairingUrl = useMemo(
    () =>
      endpointUrl != null && endpointUrl !== ""
        ? resolveHostedPairingUrl(endpointUrl, pairingLink.credential)
        : null,
    [endpointUrl, pairingLink.credential],
  );
  const endpointPairingUrl = useMemo(() => {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey);
    return endpoint ? resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential) : null;
  }, [defaultEndpointKey, endpoints, pairingLink.credential]);
  const endpointCopyOptions = useMemo(
    () => buildEndpointCopyOptions(endpoints, pairingLink.credential),
    [endpoints, pairingLink.credential],
  );
  const shareablePairingUrl =
    endpointPairingUrl ??
    (endpointUrl != null && endpointUrl !== ""
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, pairingLink.credential))
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl);
  return { shareablePairingUrl, endpointCopyOptions };
}

function copySuccessToast(kind: PairingCopyKind) {
  return {
    type: "success" as const,
    title:
      kind === "hosted-link"
        ? "Hosted app link copied"
        : kind === "link"
          ? "Pairing URL copied"
          : "Pairing code copied",
    description:
      kind === "hosted-link"
        ? "Open it in the browser on the device you want to connect."
        : kind === "link"
          ? "Open it in the client you want to pair to this environment."
          : "Paste it into another client to finish pairing.",
  };
}

function copyFailureTitle(kind: PairingCopyKind, canCopyToClipboard: boolean): string {
  return canCopyToClipboard
    ? kind === "hosted-link"
      ? "Could not copy hosted app link"
      : kind === "link"
        ? "Could not copy pairing URL"
        : "Could not copy pairing code"
    : "Clipboard copy unavailable";
}

export function usePairingLinkCopy(input: {
  readonly credential: string;
  readonly shareablePairingUrl: string | null;
  readonly canCopyToClipboard: boolean;
  readonly onCopyFailed: () => void;
}) {
  const { credential, shareablePairingUrl, canCopyToClipboard, onCopyFailed } = input;
  const { copyToClipboard } = useCopyToClipboard<PairingCopyKind>({
    onCopy: (kind) => {
      toastManager.add(copySuccessToast(kind));
    },
    onError: (error, kind) => {
      onCopyFailed();
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: copyFailureTitle(kind, canCopyToClipboard),
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });

  const copyPairingValue = useCallback(
    (value: string, kind: PairingCopyKind) => {
      copyToClipboard(value, kind);
    },
    [copyToClipboard],
  );

  const copyKindForUrl = useCallback(
    (url: string): "hosted-link" | "link" => (isHostedAppPairingUrl(url) ? "hosted-link" : "link"),
    [],
  );

  const handleCopyCode = useCallback(() => {
    copyPairingValue(credential, "code");
  }, [copyPairingValue, credential]);

  const handleCopyDefaultLink = useCallback(() => {
    if (!shareablePairingUrl) return;
    copyPairingValue(shareablePairingUrl, copyKindForUrl(shareablePairingUrl));
  }, [copyKindForUrl, copyPairingValue, shareablePairingUrl]);

  const copyUrl = useCallback(
    (url: string) => copyPairingValue(url, copyKindForUrl(url)),
    [copyKindForUrl, copyPairingValue],
  );

  return { handleCopyCode, handleCopyDefaultLink, copyUrl };
}
