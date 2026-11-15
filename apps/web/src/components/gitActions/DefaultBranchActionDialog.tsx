import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import type { resolveDefaultBranchActionDialogCopy } from "~/components/GitActionsControl.logic";

interface DefaultBranchActionDialogProps {
  readonly open: boolean;
  readonly copy: ReturnType<typeof resolveDefaultBranchActionDialogCopy> | null;
  readonly onAbort: () => void;
  readonly onContinue: () => void;
  readonly onCheckoutFeatureBranch: () => void;
}

/** Asks before running a push/PR action straight onto the default branch. */
export function DefaultBranchActionDialog({
  open,
  copy,
  onAbort,
  onContinue,
  onCheckoutFeatureBranch,
}: DefaultBranchActionDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onAbort();
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{copy?.title ?? "Run action on default refName?"}</DialogTitle>
          <DialogDescription>{copy?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="dark:border-transparent dark:bg-transparent sm:flex-wrap sm:items-center">
          <Button
            className="w-full sm:mr-auto sm:w-auto"
            variant="outline"
            size="sm"
            onClick={onAbort}
          >
            Abort
          </Button>
          <Button
            className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
            variant="outline"
            size="sm"
            onClick={onContinue}
          >
            {copy?.continueLabel ?? "Continue"}
          </Button>
          <Button
            className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
            size="sm"
            onClick={onCheckoutFeatureBranch}
          >
            Checkout feature branch & continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
