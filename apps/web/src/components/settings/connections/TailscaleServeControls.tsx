import type { AdvertisedEndpoint } from "@loop/contracts";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { SettingsRow } from "../settingsLayout";
import { BusyLabel } from "./BusyLabel";
import type { TailscaleServe } from "./useTailscaleServe";

export function TailscaleRow({
  tailscaleHttpsEndpoint,
  tailscale,
}: {
  tailscaleHttpsEndpoint: AdvertisedEndpoint | null;
  tailscale: TailscaleServe;
}) {
  return (
    <SettingsRow
      title="Tailscale HTTPS"
      description={
        tailscaleHttpsEndpoint
          ? tailscaleHttpsEndpoint.status === "available"
            ? tailscaleHttpsEndpoint.httpBaseUrl
            : "Use Tailscale Serve to expose this backend through a MagicDNS HTTPS URL."
          : "Start Tailscale to set up HTTPS access through MagicDNS."
      }
      control={
        tailscaleHttpsEndpoint ? (
          <Switch
            checked={tailscaleHttpsEndpoint.status === "available"}
            disabled={tailscale.isUpdating}
            onCheckedChange={(checked) => {
              if (checked) {
                tailscale.handleStartSetup(tailscaleHttpsEndpoint);
                return;
              }
              tailscale.handleStartDisable(tailscaleHttpsEndpoint);
            }}
            aria-label="Enable Tailscale HTTPS"
          />
        ) : null
      }
    />
  );
}

export function TailscaleServeDisableDialog({ tailscale }: { tailscale: TailscaleServe }) {
  const { isUpdating } = tailscale;
  return (
    <AlertDialog
      open={tailscale.disableDialogOpen}
      onOpenChange={(open) => {
        if (isUpdating) return;
        tailscale.setDisableDialogOpen(open);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Disable Tailscale HTTPS?</AlertDialogTitle>
          <AlertDialogDescription>
            Loop will restart the local backend without Tailscale Serve.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={isUpdating}
            render={<Button variant="outline" disabled={isUpdating} />}
          >
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => void tailscale.handleConfirmDisable()}
            disabled={isUpdating}
          >
            {isUpdating ? <BusyLabel>Restarting…</BusyLabel> : "Restart and disable"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function TailscaleServePortPanel({ tailscale }: { tailscale: TailscaleServe }) {
  return (
    <DialogPanel className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-foreground">HTTPS port</span>
        <Input
          className="mt-2"
          type="number"
          inputMode="numeric"
          min={1}
          max={65_535}
          step={1}
          value={tailscale.portInput}
          onChange={(event) => tailscale.setPortInput(event.target.value)}
          disabled={tailscale.isUpdating}
        />
      </label>
      {!tailscale.isPortValid ? (
        <p className="mt-2 text-xs text-destructive">Enter a port from 1 to 65535.</p>
      ) : null}
      <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">HTTPS endpoint</p>
        <p
          className="mt-1 truncate text-sm text-foreground"
          title={tailscale.pendingBaseUrl ?? undefined}
        >
          {tailscale.pendingBaseUrl ?? "Pending MagicDNS endpoint"}
        </p>
      </div>
    </DialogPanel>
  );
}

export function TailscaleServeSetupDialog({ tailscale }: { tailscale: TailscaleServe }) {
  const { isUpdating } = tailscale;
  return (
    <Dialog
      open={tailscale.pendingEndpoint !== null}
      onOpenChange={(open) => {
        if (isUpdating) return;
        if (!open) tailscale.setPendingEndpoint(null);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set up Tailscale HTTPS?</DialogTitle>
          <DialogDescription>
            Loop will restart the local backend with Tailscale Serve enabled and ask Tailscale to
            proxy HTTPS traffic to this backend.
          </DialogDescription>
        </DialogHeader>
        <TailscaleServePortPanel tailscale={tailscale} />
        <DialogFooter>
          <DialogClose
            disabled={isUpdating}
            render={<Button variant="outline" disabled={isUpdating} />}
          >
            Cancel
          </DialogClose>
          <Button
            onClick={() => void tailscale.handleConfirmSetup()}
            disabled={isUpdating || !tailscale.isPortValid}
          >
            {isUpdating ? <BusyLabel>Restarting…</BusyLabel> : "Enable"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
