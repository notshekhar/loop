import type { AdvertisedEndpoint } from "@loop/contracts";
import { memo } from "react";

import { Button } from "../../ui/button";
import { type AccessSectionPresentation, endpointRowClassName } from "./accessRows";
import { isTailscaleHttpsEndpoint } from "./advertisedEndpoints";

type EndpointRowActions = {
  onSetDefault: (endpoint: AdvertisedEndpoint) => void;
  onSetupTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  onDisableTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  isUpdatingTailscaleServe: boolean;
};

type AdvertisedEndpointListRowProps = EndpointRowActions & {
  endpoint: AdvertisedEndpoint;
  isDefault: boolean;
  presentation?: AccessSectionPresentation;
};

function AdvertisedEndpointActions({
  endpoint,
  isDefault,
  needsTailscaleSetup,
  onSetDefault,
  onSetupTailscaleServe,
  onDisableTailscaleServe,
  isUpdatingTailscaleServe,
}: EndpointRowActions & {
  endpoint: AdvertisedEndpoint;
  isDefault: boolean;
  needsTailscaleSetup: boolean;
}) {
  const canDisableTailscaleServe =
    isTailscaleHttpsEndpoint(endpoint) && endpoint.status === "available";
  return (
    <div className="ml-auto flex min-h-6 shrink-0 items-center justify-end gap-2">
      {isDefault ? (
        <span className="rounded-md border border-primary/30 bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
          Default
        </span>
      ) : null}
      {needsTailscaleSetup ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => onSetupTailscaleServe(endpoint)}
          disabled={isUpdatingTailscaleServe}
        >
          {isUpdatingTailscaleServe ? "Restarting…" : "Setup"}
        </Button>
      ) : null}
      {canDisableTailscaleServe ? (
        <Button
          size="xs"
          variant="destructive-outline"
          onClick={() => onDisableTailscaleServe(endpoint)}
          disabled={isUpdatingTailscaleServe}
        >
          {isUpdatingTailscaleServe ? "Restarting…" : "Disable"}
        </Button>
      ) : null}
      {!needsTailscaleSetup && !isDefault ? (
        <Button size="xs" variant="outline" onClick={() => onSetDefault(endpoint)}>
          Set as default
        </Button>
      ) : null}
    </div>
  );
}

export const AdvertisedEndpointListRow = memo(function AdvertisedEndpointListRow({
  endpoint,
  isDefault,
  presentation = "current",
  ...actions
}: AdvertisedEndpointListRowProps) {
  const isAvailable = endpoint.status === "available";
  const needsTailscaleSetup = isTailscaleHttpsEndpoint(endpoint) && endpoint.status !== "available";
  const shouldShowEndpointUrl = !needsTailscaleSetup;
  const isEndpointRail = presentation === "endpoint-rail";
  return (
    <div className={endpointRowClassName(presentation, isAvailable)}>
      {isEndpointRail && isDefault ? (
        <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex min-h-6 min-w-0 flex-col gap-2 sm:-my-0.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="shrink-0 text-sm leading-5 font-medium text-foreground">
            {endpoint.label}
          </h3>
          {shouldShowEndpointUrl ? (
            <p
              className="min-w-0 truncate text-xs leading-5 text-muted-foreground"
              title={endpoint.httpBaseUrl}
            >
              {endpoint.httpBaseUrl}
            </p>
          ) : null}
          {!isAvailable ? (
            <span className="shrink-0 rounded-md border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground">
              Setup required
            </span>
          ) : null}
        </div>
        <AdvertisedEndpointActions
          endpoint={endpoint}
          isDefault={isDefault}
          needsTailscaleSetup={needsTailscaleSetup}
          {...actions}
        />
      </div>
    </div>
  );
});
