import { useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SettingsRow } from "../settingsLayout";

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Enable Loop Connect",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

function useCloudLinkToggles(controller: ReturnType<typeof useCloudLinkController>) {
  const { managedTunnelActive, publishAgentActivity, reconcileCloudState } = controller;
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const updateManagedTunnel = async (enabled: boolean) => {
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      // Turning the tunnel off while publishing stays on downgrades the link
      // rather than removing it — say so instead of claiming an unlink.
      toastManager.add({
        type: "success",
        title: enabled
          ? "Loop Connect linked"
          : publishAgentActivity
            ? "Loop Connect tunnel disabled"
            : "Loop Connect unlinked",
        description: enabled
          ? "This environment is available through Loop Connect."
          : publishAgentActivity
            ? "The managed tunnel was removed. Agent activity publishing stays on."
            : "This environment is no longer available through Loop Connect.",
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment publishes agent activity to your mobile clients."
          : "This environment will stop publishing agent activity.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return {
    isBusy: isUpdating || isUpdatingPreference,
    updateManagedTunnel,
    updatePublishAgentActivity,
  };
}

function ConfiguredCloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  const controller = useCloudLinkController();
  const {
    isSignedIn,
    linkState: primaryCloudLinkState,
    managedTunnelActive,
    publishAgentActivity,
    operationError,
  } = controller;
  const { isBusy, updateManagedTunnel, updatePublishAgentActivity } =
    useCloudLinkToggles(controller);

  const disabledReason = !isSignedIn
    ? "Sign in to Loop Connect to manage this environment."
    : !canManageRelay
      ? "Your session does not have permission to manage Loop Connect access."
      : null;
  const disabled = !canManageRelay || !isSignedIn || primaryCloudLinkState.isPending || isBusy;

  return (
    <>
      <SettingsRow
        title="Loop Connect"
        description={
          managedTunnelActive
            ? "This environment is available to your other devices through Loop Connect."
            : "Make this environment available to your other devices through Loop Connect."
        }
        status={operationError ?? primaryCloudLinkState.error}
        control={
          <CloudLinkSwitch
            checked={managedTunnelActive}
            disabled={disabled}
            disabledReason={disabledReason}
            onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
          />
        }
      />
      <SettingsRow
        title="Publish agent activity"
        description="Send activity from this environment to your mobile clients for push notifications and Live Activities. Works without a Loop Connect tunnel."
        control={
          <CloudLinkSwitch
            ariaLabel="Publish agent activity to mobile clients"
            checked={publishAgentActivity}
            disabled={disabled}
            disabledReason={disabledReason}
            onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
          />
        }
      />
    </>
  );
}

export function CloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  return hasCloudPublicConfig() ? <ConfiguredCloudLinkRow canManageRelay={canManageRelay} /> : null;
}
