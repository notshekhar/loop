import { ChevronsLeftRightEllipsisIcon, PlusIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { AnimatedHeight } from "../../AnimatedHeight";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SshBackendFields } from "./SshBackendFields";
import type { AddBackendForm, AddBackendMode } from "./useAddBackendForm";
import type { SshHosts } from "./useSshHosts";

function ConnectionModeCard({
  form,
  mode,
  title,
  description,
  icon,
}: {
  readonly form: AddBackendForm;
  readonly mode: AddBackendMode;
  readonly title: string;
  readonly description: string;
  readonly icon?: ReactNode;
}) {
  const selected = form.mode === mode;
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
        selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
      )}
      disabled={form.isAdding}
      onClick={() => {
        form.setMode(mode);
      }}
    >
      {icon ? (
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
            selected
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

function RemoteBackendFields({ form }: { form: AddBackendForm }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Host</span>
          <Input
            value={form.host}
            onChange={(event) => form.handleHostChange(event.target.value)}
            placeholder="backend.example.com"
            disabled={form.isAdding}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Pairing code</span>
          <Input
            value={form.pairingCode}
            onChange={(event) => form.setPairingCode(event.target.value)}
            placeholder="123 456"
            disabled={form.isAdding}
            spellCheck={false}
          />
        </label>
      </div>
      <div>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          Type the host and the six-digit code that loop serve (or /rc) shows on that computer, or
          paste its full pairing URL to fill both fields.
        </span>
      </div>
    </div>
  );
}

function RemoteBackendBody({ form, onAdd }: { form: AddBackendForm; onAdd: () => void }) {
  return (
    <div className="space-y-4">
      <RemoteBackendFields form={form} />
      {form.error ? <p className="text-xs text-destructive">{form.error}</p> : null}
      <Button variant="outline" className="w-full" disabled={form.isAdding} onClick={onAdd}>
        <PlusIcon className="size-3.5" />
        {form.isAdding ? "Adding…" : "Add host"}
      </Button>
    </div>
  );
}

function AddBackendTrigger() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                className="h-5 gap-1 rounded-sm px-1 text-[11px] font-normal text-muted-foreground/60 hover:text-muted-foreground"
                aria-label="Add host"
              >
                <PlusIcon className="size-3" />
                <span>Add host</span>
              </Button>
            }
          />
        }
      />
      <TooltipPopup side="top">Add host</TooltipPopup>
    </Tooltip>
  );
}

export function AddBackendDialog({
  form,
  sshHosts,
  canUseSsh,
  onAdd,
}: {
  form: AddBackendForm;
  sshHosts: SshHosts;
  canUseSsh: boolean;
  onAdd: () => void;
}) {
  return (
    <Dialog open={form.dialogOpen} onOpenChange={form.handleDialogOpenChange}>
      <AddBackendTrigger />
      <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add a host</DialogTitle>
          <DialogDescription>
            Another computer running loop: its sessions show up here next to this one's.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <ConnectionModeCard
                form={form}
                mode="remote"
                title="Remote link"
                description="Enter a backend host and pairing code."
                icon={<ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />}
              />
              {canUseSsh ? (
                <ConnectionModeCard
                  form={form}
                  mode="ssh"
                  title="SSH"
                  description="Use local SSH config, agent, and tunnels for the backend."
                  icon={<TerminalIcon aria-hidden className="size-4" />}
                />
              ) : null}
            </div>
            <AnimatedHeight>
              {form.mode === "ssh" ? (
                <SshBackendFields form={form} sshHosts={sshHosts} onAdd={onAdd} />
              ) : (
                <RemoteBackendBody form={form} onAdd={onAdd} />
              )}
            </AnimatedHeight>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
