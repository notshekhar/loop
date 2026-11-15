import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "@loop/contracts";
import { PlusIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import {
  createServerPairingCredential,
  type ServerClientSessionRecord,
} from "~/environments/primary";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
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
import { Input } from "../../ui/input";
import { errorMessage, showErrorToast } from "./connectionToasts";

const PAIRING_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthEnvironmentScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: "View environment",
    description: "Read threads, status, diffs, and configuration.",
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: "Operate tasks",
    description: "Start tasks and perform changes in the environment.",
  },
  {
    scope: AuthTerminalOperateScope,
    title: "Use terminals",
    description: "Create terminals and send input to running shells.",
  },
  {
    scope: AuthReviewWriteScope,
    title: "Write reviews",
    description: "Create comments while reviewing changes.",
  },
  {
    scope: AuthAccessReadScope,
    title: "View access",
    description: "Inspect pairing links and authorized clients.",
  },
  {
    scope: AuthAccessWriteScope,
    title: "Manage access",
    description: "Issue and revoke credentials for other clients.",
  },
  {
    scope: AuthRelayReadScope,
    title: "View relay",
    description: "Inspect managed relay connectivity.",
  },
  {
    scope: AuthRelayWriteScope,
    title: "Manage relay",
    description: "Change managed tunnel connectivity.",
  },
];

function useCreatePairingLinkForm() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingScopes, setPairingScopes] = useState<ReadonlyArray<AuthEnvironmentScope>>([
    ...AuthStandardClientScopes,
  ]);
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = useCallback(async () => {
    setIsCreatingPairingLink(true);
    try {
      await createServerPairingCredential({ label: pairingLabel, scopes: pairingScopes });
      setPairingLabel("");
      setPairingScopes([...AuthStandardClientScopes]);
      setDialogOpen(false);
    } catch (error) {
      showErrorToast(
        "Could not create pairing URL",
        errorMessage(error, "Failed to create pairing URL."),
      );
    } finally {
      setIsCreatingPairingLink(false);
    }
  }, [pairingLabel, pairingScopes]);

  const togglePairingScope = useCallback((scope: AuthEnvironmentScope, checked: boolean) => {
    setPairingScopes((current) =>
      checked ? [...current, scope] : current.filter((currentScope) => currentScope !== scope),
    );
  }, []);

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setPairingLabel("");
      setPairingScopes([...AuthStandardClientScopes]);
    }
  };

  return {
    dialogOpen,
    setDialogOpen,
    handleDialogOpenChange,
    pairingLabel,
    setPairingLabel,
    pairingScopes,
    setPairingScopes,
    togglePairingScope,
    isCreatingPairingLink,
    handleCreatePairingLink,
  };
}

type PairingScopeProps = {
  pairingScopes: ReadonlyArray<AuthEnvironmentScope>;
  disabled: boolean;
  onToggleScope: (scope: AuthEnvironmentScope, checked: boolean) => void;
};

function PairingScopeCheckboxes({ pairingScopes, disabled, onToggleScope }: PairingScopeProps) {
  return (
    <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
      {PAIRING_SCOPE_OPTIONS.map(({ scope, title, description }) => (
        <label
          key={scope}
          className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
        >
          <Checkbox
            className="mt-0.5"
            checked={pairingScopes.includes(scope)}
            disabled={disabled}
            onCheckedChange={(checked) => onToggleScope(scope, checked === true)}
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">{title}</span>
            <span className="block text-xs leading-snug text-muted-foreground">
              {description}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

function PairingScopePicker({
  pairingScopes,
  disabled,
  onSetScopes,
  onToggleScope,
}: PairingScopeProps & {
  onSetScopes: (scopes: ReadonlyArray<AuthEnvironmentScope>) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium text-foreground">Permissions</h3>
          <p className="text-xs text-muted-foreground">Limit what the paired client can do.</p>
        </div>
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onSetScopes([AuthOrchestrationReadScope])}
          >
            Read only
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onSetScopes([...AuthStandardClientScopes])}
          >
            Standard
          </Button>
        </div>
      </div>
      <PairingScopeCheckboxes
        pairingScopes={pairingScopes}
        disabled={disabled}
        onToggleScope={onToggleScope}
      />
      {pairingScopes.length === 0 ? (
        <p className="text-xs text-destructive">Select at least one permission.</p>
      ) : pairingScopes.includes(AuthAccessWriteScope) ? (
        <p className="text-xs text-warning">
          This client can create or revoke access for other devices.
        </p>
      ) : null}
    </section>
  );
}

function CreatePairingLinkDialog() {
  const form = useCreatePairingLinkForm();
  return (
    <Dialog open={form.dialogOpen} onOpenChange={form.handleDialogOpenChange}>
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            Create link
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create pairing link</DialogTitle>
          <DialogDescription>
            Generate a one-time link that another device can use to pair with this backend as an
            authorized client.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Client label (optional)
            </span>
            <Input
              value={form.pairingLabel}
              onChange={(event) => form.setPairingLabel(event.target.value)}
              placeholder="e.g. Living room iPad"
              disabled={form.isCreatingPairingLink}
              autoFocus
            />
          </label>
          <PairingScopePicker
            pairingScopes={form.pairingScopes}
            disabled={form.isCreatingPairingLink}
            onSetScopes={form.setPairingScopes}
            onToggleScope={form.togglePairingScope}
          />
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            disabled={form.isCreatingPairingLink}
            onClick={() => form.setDialogOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={form.isCreatingPairingLink || form.pairingScopes.length === 0}
            onClick={() => void form.handleCreatePairingLink()}
          >
            {form.isCreatingPairingLink ? "Creating…" : "Create link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type AuthorizedClientsHeaderActionProps = {
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
};

export const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
}: AuthorizedClientsHeaderActionProps) {
  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={
          isRevokingOtherClients || clientSessions.every((clientSession) => clientSession.current)
        }
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? "Revoking…" : "Revoke others"}
      </Button>
      <CreatePairingLinkDialog />
    </div>
  );
});
