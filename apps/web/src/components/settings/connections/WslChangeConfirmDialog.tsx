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
import { BusyLabel } from "./BusyLabel";
import type { PendingWslChange, WslBackend } from "./useWslBackend";

function wslChangeTitle(pendingWslChange: PendingWslChange | null): string {
  return pendingWslChange?.kind === "disable"
    ? pendingWslChange.wasWslOnly
      ? "Turn off WSL and switch back to Windows?"
      : "Disable WSL backend?"
    : pendingWslChange?.kind === "distro"
      ? "Switch WSL distro?"
      : pendingWslChange?.kind === "enable"
        ? "Start the WSL backend"
        : pendingWslChange?.nextValue
          ? "Run only the WSL backend?"
          : "Re-enable the Windows backend?";
}

function wslChangeDescription(pendingWslChange: PendingWslChange | null): string {
  return pendingWslChange?.kind === "disable"
    ? pendingWslChange.wasWslOnly
      ? "Loop will restart on the Windows backend. Threads and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL."
      : "The WSL backend will stop. Threads and projects opened against WSL stay safe inside the distro, but they'll be unavailable in Loop until you re-enable WSL."
    : pendingWslChange?.kind === "distro"
      ? "Loop will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted."
      : pendingWslChange?.kind === "enable"
        ? "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings."
        : pendingWslChange?.nextValue
          ? "Loop will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again."
          : "Loop will restart and bring the Windows backend back up alongside WSL.";
}

type ConfirmableWslChange = Exclude<PendingWslChange, { readonly kind: "enable" }>;

function wslConfirmLabel(pendingWslChange: ConfirmableWslChange | null): string {
  return pendingWslChange?.kind === "disable"
    ? pendingWslChange.wasWslOnly
      ? "Switch to Windows"
      : "Disable WSL"
    : pendingWslChange?.kind === "distro"
      ? "Switch distro"
      : pendingWslChange?.nextValue
        ? "Restart and enable"
        : "Restart and disable";
}

function EnableWslActions({ wsl }: { wsl: WslBackend }) {
  return (
    <>
      <Button
        variant="outline"
        onClick={() => wsl.handleConfirmEnableWsl("wsl-only")}
        disabled={wsl.isUpdating}
      >
        {wsl.isUpdating ? <BusyLabel>Applying…</BusyLabel> : "Use only WSL"}
      </Button>
      <Button
        variant="default"
        onClick={() => wsl.handleConfirmEnableWsl("both")}
        disabled={wsl.isUpdating}
      >
        {wsl.isUpdating ? <BusyLabel>Applying…</BusyLabel> : "Run both backends"}
      </Button>
    </>
  );
}

function ConfirmWslChangeAction({
  wsl,
  pendingWslChange,
}: {
  wsl: WslBackend;
  pendingWslChange: ConfirmableWslChange | null;
}) {
  return (
    <Button
      variant={
        pendingWslChange?.kind === "disable" ||
        (pendingWslChange?.kind === "wsl-only" && pendingWslChange.nextValue)
          ? "destructive"
          : "default"
      }
      onClick={wsl.handleConfirmWslChange}
      disabled={wsl.isUpdating}
    >
      {wsl.isUpdating ? <BusyLabel>Applying…</BusyLabel> : wslConfirmLabel(pendingWslChange)}
    </Button>
  );
}

export function WslChangeConfirmDialog({ wsl }: { wsl: WslBackend }) {
  const pendingWslChange = wsl.pendingChange;
  return (
    <AlertDialog
      open={pendingWslChange !== null}
      onOpenChange={(open) => {
        if (wsl.isUpdating) return;
        if (!open) wsl.setPendingChange(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{wslChangeTitle(pendingWslChange)}</AlertDialogTitle>
          <AlertDialogDescription>{wslChangeDescription(pendingWslChange)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={wsl.isUpdating}
            render={<Button variant="outline" disabled={wsl.isUpdating} />}
          >
            Cancel
          </AlertDialogClose>
          {pendingWslChange?.kind === "enable" ? (
            <EnableWslActions wsl={wsl} />
          ) : (
            <ConfirmWslChangeAction wsl={wsl} pendingWslChange={pendingWslChange} />
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
