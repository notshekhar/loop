import type { EnvironmentId } from "@loop/contracts";
import { ChevronsLeftRightEllipsisIcon } from "lucide-react";

import type { EnvironmentPresentation } from "~/state/environments";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { CloudEnvironmentConnectRows } from "../../cloud/CloudEnvironmentConnectList";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../ui/empty";
import { SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { AddBackendDialog } from "./AddBackendDialog";
import { SavedBackendListRow } from "./SavedBackendListRow";
import type { AddBackendForm } from "./useAddBackendForm";
import type { useSavedBackendActions } from "./useSavedBackendActions";
import type { SshHosts } from "./useSshHosts";

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No other computers yet</EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? "Run loop serve (or /rc) on the other computer, then click “Add host” and type its address and 6-digit code — or connect one from Loop Connect."
            : "Run loop serve (or /rc) on the other computer, then click “Add host” and type its address and 6-digit code."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={<EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}

/** "Other computers": saved remote/SSH environments and the dialog that adds one. */
export function RemoteEnvironmentsSection({
  primaryEnvironmentId,
  savedEnvironments,
  addBackendForm,
  sshHosts,
  canUseSsh,
  onAddBackend,
  savedBackendActions,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly addBackendForm: AddBackendForm;
  readonly sshHosts: SshHosts;
  readonly canUseSsh: boolean;
  readonly onAddBackend: () => void;
  readonly savedBackendActions: ReturnType<typeof useSavedBackendActions>;
}) {
  return (
    <SettingsSection
      {...searchableSetting("remote-environments")}
      headerAction={
        <AddBackendDialog
          form={addBackendForm}
          sshHosts={sshHosts}
          canUseSsh={canUseSsh}
          onAdd={onAddBackend}
        />
      }
    >
      {savedEnvironments.map((environment) => (
        <SavedBackendListRow
          key={environment.environmentId}
          environment={environment}
          removingEnvironmentId={savedBackendActions.removingEnvironmentId}
          onConnect={savedBackendActions.handleConnect}
          onRemove={savedBackendActions.handleRemove}
        />
      ))}
      <CloudRemoteEnvironmentRows
        primaryEnvironmentId={primaryEnvironmentId}
        savedEnvironments={savedEnvironments}
      />
    </SettingsSection>
  );
}
