import { ChevronDownIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Group, GroupSeparator } from "../../ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { isHostedAppPairingUrl } from "./advertisedEndpoints";
import type { EndpointCopyOption } from "./usePairingLinkShare";

type CopyMenuActions = {
  readonly onCopyUrl: (url: string) => void;
  readonly onCopyCode: () => void;
};

function EndpointMenuGroup({
  label,
  options,
  includeSeparator,
  onCopyUrl,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<EndpointCopyOption>;
  readonly includeSeparator: boolean;
  readonly onCopyUrl: (url: string) => void;
}) {
  return options.length > 0 ? (
    <>
      {includeSeparator ? <MenuSeparator /> : null}
      <MenuGroup>
        <MenuGroupLabel>{label}</MenuGroupLabel>
        {options.map((option) => (
          <MenuItem key={option.key} onClick={() => onCopyUrl(option.url)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{option.label}</span>
            </span>
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  ) : null;
}

function PairingCopyMenuItems({
  endpointCopyOptions,
  onCopyUrl,
  onCopyCode,
}: CopyMenuActions & { readonly endpointCopyOptions: ReadonlyArray<EndpointCopyOption> }) {
  const backendEndpointCopyOptions = endpointCopyOptions.filter(
    (option) => !isHostedAppPairingUrl(option.url),
  );
  const hostedEndpointCopyOptions = endpointCopyOptions.filter((option) =>
    isHostedAppPairingUrl(option.url),
  );
  return (
    <>
      <EndpointMenuGroup
        label="Pairing URLs"
        options={backendEndpointCopyOptions}
        includeSeparator={false}
        onCopyUrl={onCopyUrl}
      />
      <EndpointMenuGroup
        label="Hosted app link"
        options={hostedEndpointCopyOptions}
        includeSeparator={backendEndpointCopyOptions.length > 0}
        onCopyUrl={onCopyUrl}
      />
      {endpointCopyOptions.length > 0 ? <MenuSeparator /> : null}
      <MenuGroup>
        <MenuGroupLabel>Pairing code</MenuGroupLabel>
        <MenuItem onClick={onCopyCode}>
          <span className="min-w-0 flex-1">
            <span className="block truncate">Copy code</span>
          </span>
        </MenuItem>
      </MenuGroup>
    </>
  );
}

export function PairingLinkCopyMenu({
  endpointCopyOptions,
  defaultEndpointKey,
  onCopyDefaultLink,
  onCopyUrl,
  onCopyCode,
}: CopyMenuActions & {
  readonly endpointCopyOptions: ReadonlyArray<EndpointCopyOption>;
  readonly defaultEndpointKey: string | null;
  readonly onCopyDefaultLink: () => void;
}) {
  const defaultEndpointCopyOption =
    endpointCopyOptions.find((option) => option.key === defaultEndpointKey) ??
    endpointCopyOptions[0] ??
    null;
  const defaultEndpointCopyLabel = defaultEndpointCopyOption?.label ?? "URL";
  return (
    <Group aria-label="Copy selected endpoint">
      <Button
        size="xs"
        variant="outline"
        className="max-w-56"
        title={`Copy pairing URL for: ${defaultEndpointCopyLabel}`}
        onClick={onCopyDefaultLink}
      >
        <span className="truncate">Copy pairing URL for: {defaultEndpointCopyLabel}</span>
      </Button>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="outline" aria-label="Choose endpoint to copy" />}
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-60">
          <PairingCopyMenuItems
            endpointCopyOptions={endpointCopyOptions}
            onCopyUrl={onCopyUrl}
            onCopyCode={onCopyCode}
          />
        </MenuPopup>
      </Menu>
    </Group>
  );
}
