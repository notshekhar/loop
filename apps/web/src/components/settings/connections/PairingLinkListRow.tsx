import type { AdvertisedEndpoint } from "@loop/contracts";
import { QrCodeIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import type { ServerPairingLinkRecord } from "~/environments/primary";
import { formatExpiresInLabel } from "../../../timestampFormat";
import { ConnectionStatusDot } from "../../ConnectionStatusDot";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { QRCodeSvg } from "../../ui/qr-code";
import { Textarea } from "../../ui/textarea";
import { ITEM_ROW_INNER_CLASSNAME } from "../itemRows";
import { useRelativeTimeTick } from "../settingsLayout";
import { AccessScopeSummary } from "./AccessScopeSummary";
import {
  type AccessSectionPresentation,
  accessRowClassName,
  formatAccessTimestamp,
} from "./accessRows";
import { isHostedAppPairingUrl } from "./advertisedEndpoints";
import { PairingLinkCopyMenu } from "./PairingLinkCopyMenu";
import {
  type EndpointCopyOption,
  usePairingLinkCopy,
  usePairingLinkUrls,
} from "./usePairingLinkShare";

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  presentation?: AccessSectionPresentation;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

function PairingLinkQrPopover({ shareablePairingUrl }: { shareablePairingUrl: string | null }) {
  return (
    <Popover>
      {shareablePairingUrl ? (
        <>
          <PopoverTrigger
            openOnHover
            delay={250}
            closeDelay={100}
            render={
              <button
                type="button"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 outline-none hover:text-foreground"
                aria-label="Show QR code"
              />
            }
          >
            <QrCodeIcon aria-hidden className="size-3" />
          </PopoverTrigger>
          <PopoverPopup side="top" align="start" tooltipStyle className="w-max">
            <QRCodeSvg
              value={shareablePairingUrl}
              size={88}
              level="M"
              marginSize={2}
              title="Pairing link — scan to open on another device"
            />
          </PopoverPopup>
        </>
      ) : null}
    </Popover>
  );
}

function revealDialogCopy(shareablePairingUrl: string | null) {
  const isShareableHostedAppPairingUrl =
    shareablePairingUrl !== null && isHostedAppPairingUrl(shareablePairingUrl);
  return {
    title: shareablePairingUrl
      ? isShareableHostedAppPairingUrl
        ? "Hosted app pairing link"
        : "Pairing link"
      : "Pairing code",
    description: shareablePairingUrl
      ? isShareableHostedAppPairingUrl
        ? "Clipboard copy is unavailable here. Open or manually copy this hosted app link on the device you want to connect."
        : "Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect."
      : "Clipboard copy is unavailable here. Manually copy this code into another client.",
  };
}

function PairingRevealDialogPopup({
  shareablePairingUrl,
  revealValue,
  canCopyToClipboard,
  onDone,
  onCopyCode,
}: {
  shareablePairingUrl: string | null;
  revealValue: string;
  canCopyToClipboard: boolean;
  onDone: () => void;
  onCopyCode: () => void;
}) {
  const copy = revealDialogCopy(shareablePairingUrl);
  return (
    <DialogPopup className="max-w-md">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <Textarea
          readOnly
          value={revealValue}
          rows={shareablePairingUrl ? 4 : 3}
          className="text-xs leading-relaxed"
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
        />
        {shareablePairingUrl ? (
          <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
            <QRCodeSvg
              value={shareablePairingUrl}
              size={132}
              level="M"
              marginSize={2}
              title="Pairing link — scan to open on another device"
            />
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onDone}>
          Done
        </Button>
        {canCopyToClipboard ? (
          <Button variant="outline" size="xs" onClick={onCopyCode}>
            Copy code
          </Button>
        ) : null}
      </DialogFooter>
    </DialogPopup>
  );
}

function PairingLinkSummary({
  pairingLink,
  shareablePairingUrl,
  nowMs,
}: {
  pairingLink: ServerPairingLinkRecord;
  shareablePairingUrl: string | null;
  nowMs: number;
}) {
  return (
  <div className="min-w-0 flex-1 space-y-1">
    <div className="flex min-h-5 items-center gap-1.5">
      <ConnectionStatusDot
        tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
        dotClassName="bg-amber-400"
      />
      <h3 className="text-sm font-medium text-foreground">
        {pairingLink.label ?? "Pairing link"}
      </h3>
      <PairingLinkQrPopover shareablePairingUrl={shareablePairingUrl} />
    </div>
    <p
      className="text-xs text-muted-foreground"
      title={formatAccessTimestamp(pairingLink.expiresAt)}
    >
      {formatExpiresInLabel(pairingLink.expiresAt, nowMs)}
      <span aria-hidden> · </span>
      <AccessScopeSummary scopes={pairingLink.scopes} label="Pairing link scopes" />
    </p>
    {shareablePairingUrl === null ? (
      <p className="text-[11px] text-muted-foreground/70">
        Copy the token and pair from another client using this backend&apos;s reachable host.
      </p>
    ) : null}
  </div>
  );
}

// Without clipboard access (insecure context) the only way to share is to
// open the reveal dialog and copy by hand.
function PairingLinkCopyTrigger({
  canCopyToClipboard,
  shareablePairingUrl,
  endpointCopyOptions,
  defaultEndpointKey,
  onCopyDefaultLink,
  onCopyUrl,
  onCopyCode,
}: {
  canCopyToClipboard: boolean;
  shareablePairingUrl: string | null;
  endpointCopyOptions: ReadonlyArray<EndpointCopyOption>;
  defaultEndpointKey: string | null;
  onCopyDefaultLink: () => void;
  onCopyUrl: (url: string) => void;
  onCopyCode: () => void;
}) {
  return canCopyToClipboard ? (
    shareablePairingUrl ? (
      <PairingLinkCopyMenu
        endpointCopyOptions={endpointCopyOptions}
        defaultEndpointKey={defaultEndpointKey}
        onCopyDefaultLink={onCopyDefaultLink}
        onCopyUrl={onCopyUrl}
        onCopyCode={onCopyCode}
      />
    ) : (
      <Button size="xs" variant="outline" onClick={onCopyCode}>
        Copy code
      </Button>
    )
  ) : (
    <DialogTrigger render={<Button size="xs" variant="outline" />}>
      {shareablePairingUrl ? "Show link" : "Show code"}
    </DialogTrigger>
  );
}

function canUseClipboard(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null
  );
}

export const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  presentation = "current",
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  );
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);
  const { shareablePairingUrl, endpointCopyOptions } = usePairingLinkUrls({
    pairingLink,
    endpointUrl,
    endpoints,
    defaultEndpointKey,
  });
  const canCopyToClipboard = canUseClipboard();
  const { handleCopyCode, handleCopyDefaultLink, copyUrl } = usePairingLinkCopy({
    credential: pairingLink.credential,
    shareablePairingUrl,
    canCopyToClipboard,
    onCopyFailed: () => setIsRevealDialogOpen(true),
  });

  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={accessRowClassName(presentation)}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <PairingLinkSummary
          pairingLink={pairingLink}
          shareablePairingUrl={shareablePairingUrl}
          nowMs={nowMs}
        />
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog open={isRevealDialogOpen} onOpenChange={setIsRevealDialogOpen}>
            <PairingLinkCopyTrigger
              canCopyToClipboard={canCopyToClipboard}
              shareablePairingUrl={shareablePairingUrl}
              endpointCopyOptions={endpointCopyOptions}
              defaultEndpointKey={defaultEndpointKey}
              onCopyDefaultLink={handleCopyDefaultLink}
              onCopyUrl={copyUrl}
              onCopyCode={handleCopyCode}
            />
            <PairingRevealDialogPopup
              shareablePairingUrl={shareablePairingUrl}
              revealValue={shareablePairingUrl ?? pairingLink.credential}
              canCopyToClipboard={canCopyToClipboard}
              onDone={() => setIsRevealDialogOpen(false)}
              onCopyCode={handleCopyCode}
            />
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </div>
    </div>
  );
});
