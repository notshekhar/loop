import type { DesktopDiscoveredSshHost } from "@loop/contracts";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ScrollArea } from "../../ui/scroll-area";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../itemRows";
import { formatDesktopSshTarget } from "./sshTargets";
import type { AddBackendForm } from "./useAddBackendForm";
import type { SshHosts } from "./useSshHosts";

interface DesktopSshHostRowProps {
  target: DesktopDiscoveredSshHost;
  connectingHostAlias: string | null;
  onConnect: (target: DesktopDiscoveredSshHost) => void;
}

const DesktopSshHostRow = memo(function DesktopSshHostRow({
  target,
  connectingHostAlias,
  onConnect,
}: DesktopSshHostRowProps) {
  const address = formatDesktopSshTarget(target);
  const showAddress = address !== target.alias;
  const buttonLabel = connectingHostAlias === target.alias ? "Adding…" : "Add environment";

  return (
    <div className="rounded-xl px-3 py-3 sm:px-4">
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">{target.alias}</h3>
          {showAddress ? <p className="truncate text-xs text-muted-foreground">{address}</p> : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={connectingHostAlias === target.alias}
            onClick={() => onConnect(target)}
          >
            {connectingHostAlias === target.alias ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : null}
            {buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
});

function SuggestedSshHosts({ sshHosts }: { sshHosts: SshHosts }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">Suggested hosts</p>
          <p className="text-[11px] text-muted-foreground">From SSH config and known hosts</p>
        </div>
        <Button size="xs" variant="ghost" disabled={sshHosts.isLoading} onClick={sshHosts.refresh}>
          {sshHosts.isLoading ? (
            <RefreshCwIcon className="size-3 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
          Refresh
        </Button>
      </div>
      <ScrollArea scrollFade className="max-h-56">
        <div>
          {sshHosts.unsavedHosts.map((target) => (
            <DesktopSshHostRow
              key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
              target={target}
              connectingHostAlias={sshHosts.connectingHostAlias}
              onConnect={(nextTarget) => void sshHosts.handleConnectSshHost(nextTarget)}
            />
          ))}
          {sshHosts.hasLoaded && !sshHosts.isLoading && sshHosts.unsavedHosts.length === 0 ? (
            <div className={ITEM_ROW_CLASSNAME}>
              <p className="text-xs text-muted-foreground">No new SSH hosts were discovered.</p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function SshTargetInputs({ form }: { form: AddBackendForm }) {
  return (
    <>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">SSH host or alias</span>
        <Input
          value={form.sshHost}
          onChange={(event) => form.setSshHost(event.target.value)}
          placeholder="Search hosts or type devbox"
          disabled={form.isAdding}
          spellCheck={false}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Username</span>
          <Input
            value={form.sshUsername}
            onChange={(event) => form.setSshUsername(event.target.value)}
            placeholder="root"
            disabled={form.isAdding}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Port</span>
          <Input
            value={form.sshPort}
            onChange={(event) => form.setSshPort(event.target.value)}
            placeholder="22"
            inputMode="numeric"
            disabled={form.isAdding}
            spellCheck={false}
          />
        </label>
      </div>
    </>
  );
}

export function SshBackendFields({
  form,
  sshHosts,
  onAdd,
}: {
  form: AddBackendForm;
  sshHosts: SshHosts;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <SshTargetInputs form={form} />
        {form.error || sshHosts.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {form.error ?? sshHosts.error}
          </div>
        ) : null}
        <Button variant="outline" className="w-full" disabled={form.isAdding} onClick={onAdd}>
          <PlusIcon className="size-3.5" />
          {form.isAdding ? "Adding…" : "Add host"}
        </Button>
      </div>
      <SuggestedSshHosts sshHosts={sshHosts} />
    </div>
  );
}
