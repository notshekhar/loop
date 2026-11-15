import type { DesktopWslState } from "@loop/contracts";

import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { SettingsRow } from "../settingsLayout";
import { BACKEND_VALUE_DEFAULT_WSL, BACKEND_VALUE_WSL_OFF, type WslBackend } from "./useWslBackend";

function WslErrorStatus({ error }: { error: string }) {
  return <span className="block text-destructive">{error}</span>;
}

// Distro is null when the user wants the WSL default. Map it to the
// real default's name so the Select highlights a real option; fall
// back to the sentinel only when no distros are listed yet (the
// dropdown then renders a single placeholder that matches).
function wslSelectValue(state: DesktopWslState): string {
  const defaultDistroName = state.distros.find((distro) => distro.isDefault)?.name ?? null;
  return !state.enabled
    ? BACKEND_VALUE_WSL_OFF
    : (state.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL);
}

function wslSelectLabel(selectValue: string): string {
  return selectValue === BACKEND_VALUE_WSL_OFF
    ? "Off"
    : selectValue === BACKEND_VALUE_DEFAULT_WSL
      ? "Default distro"
      : selectValue;
}

function WslDistroSelect({ state, wsl }: { state: DesktopWslState; wsl: WslBackend }) {
  const selectValue = wslSelectValue(state);
  return (
    <Select
      value={selectValue}
      onValueChange={(value) => {
        if (typeof value !== "string") return;
        wsl.handleSelectWslMode(value);
      }}
    >
      <SelectTrigger className="w-full sm:w-56" aria-label="WSL backend" disabled={wsl.isUpdating}>
        <SelectValue>{wslSelectLabel(selectValue)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
          Off
        </SelectItem>
        {state.distros.length === 0 ? (
          <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
            Default distro
          </SelectItem>
        ) : (
          state.distros.map((distro) => (
            <SelectItem hideIndicator key={distro.name} value={distro.name}>
              {distro.name}
              {distro.isDefault ? " (default)" : ""}
            </SelectItem>
          ))
        )}
      </SelectPopup>
    </Select>
  );
}

function WslAvailableRows({ state, wsl }: { state: DesktopWslState; wsl: WslBackend }) {
  return (
    <>
      <SettingsRow
        title="WSL backend"
        description="Run a second backend inside a WSL distro alongside the Windows one. Pick a distro to start it; pick Off to stop it. Projects opened against the WSL backend live on the Linux side; Windows projects stay where they are."
        status={
          wsl.error ? (
            <WslErrorStatus error={wsl.error} />
          ) : state.preflightError ? (
            <span className="block text-destructive">
              WSL backend couldn't start: {state.preflightError}
            </span>
          ) : null
        }
        control={<WslDistroSelect state={state} wsl={wsl} />}
      />
      {state.enabled ? (
        <SettingsRow
          title="WSL only"
          description="Stop the Windows backend and run only the WSL backend. Useful if you develop entirely inside WSL and don't want a second backend process. Loop restarts when you change this."
          className="bg-muted/20 pl-7 sm:pl-8"
          control={
            <Switch
              checked={state.wslOnly}
              disabled={wsl.isUpdating}
              onCheckedChange={(checked) => wsl.handleToggleWslOnly(checked)}
              aria-label="Run WSL only"
            />
          }
        />
      ) : null}
    </>
  );
}

// WSL went unavailable while the user still has the WSL backend persisted
// (it may have been uninstalled or its distro removed). The desktop side
// falls back to the Windows backend, but the normal distro picker needs a
// live distro list it no longer has. Without a control here the user would
// be stranded on a WSL preference they can't clear, so render a recovery
// row that switches back to Windows. When WSL is unavailable AND unused,
// there's nothing to recover — keep the section hidden as before.
function WslUnavailableRow({ state, wsl }: { state: DesktopWslState; wsl: WslBackend }) {
  if (!state.enabled && !state.wslOnly) return null;
  return (
    <SettingsRow
      title="WSL backend"
      description="WSL is no longer available, so the Windows backend is running instead. Switch off the WSL backend to clear this preference."
      status={wsl.error ? <WslErrorStatus error={wsl.error} /> : null}
      control={
        <Button
          variant="outline"
          disabled={wsl.isUpdating}
          onClick={() => wsl.handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
        >
          Switch to Windows
        </Button>
      }
    />
  );
}

// A load failed: keep a recovery row (with retry) visible instead of
// silently hiding the section. The error persists across an in-flight
// retry so the row doesn't flicker away, and the button reflects the
// loading state. With no error we simply haven't loaded yet (or WSL
// management isn't available), so render nothing.
function WslLoadFailedRow({ wsl, canManageLocalBackend }: WslBackendRowsProps) {
  if (!(wsl.error && canManageLocalBackend)) return null;
  return (
    <SettingsRow
      title="WSL backend"
      description="Couldn't load the WSL backend state."
      status={<WslErrorStatus error={wsl.error} />}
      control={
        <Button size="xs" variant="outline" onClick={wsl.loadWslState} disabled={wsl.isLoading}>
          {wsl.isLoading ? "Retrying…" : "Retry"}
        </Button>
      }
    />
  );
}

type WslBackendRowsProps = { wsl: WslBackend; canManageLocalBackend: boolean };

export function WslBackendRows(props: WslBackendRowsProps) {
  const state = props.wsl.state;
  if (!state) return <WslLoadFailedRow {...props} />;
  if (!state.available) return <WslUnavailableRow state={state} wsl={props.wsl} />;
  return <WslAvailableRows state={state} wsl={props.wsl} />;
}
