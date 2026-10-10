/**
 * The host's "thread teams" switch, one row per connected computer — off by
 * default, and per host because the host is what runs a team's threads.
 * A computer on a loop that predates thread teams shows no row.
 */
import { EnvironmentId } from "@loop/contracts";
import { useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { teamAtoms } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

function ThreadTeamsRow(props: {
  readonly environmentId: string;
  readonly label: string;
  readonly showLabel: boolean;
}) {
  const environmentId = EnvironmentId.make(props.environmentId);
  const atom = useMemo(() => teamAtoms.setting({ environmentId, input: {} }), [environmentId]);
  const query = useEnvironmentQuery(atom);
  const set = useAtomCommand(teamAtoms.setSetting, "Change thread teams");
  const [pending, setPending] = useState<boolean | null>(null);
  if (!query.data?.supported) return null;
  return (
    <SettingsSwitchRow
      icon="point.3.connected.trianglepath.dotted"
      label={props.showLabel ? `Thread teams · ${props.label}` : "Thread teams"}
      value={pending ?? query.data.enabled}
      onValueChange={(enabled) => {
        setPending(enabled);
        void set({ environmentId, input: { enabled } }).finally(() => {
          query.refresh();
          setPending(null);
        });
      }}
    />
  );
}

export function ThreadTeamsSettingsSection() {
  const { environments } = useEnvironments();
  if (environments.length === 0) return null;
  return (
    <SettingsSection title="Agent">
      {environments.map((environment) => (
        <ThreadTeamsRow
          environmentId={String(environment.environmentId)}
          key={String(environment.environmentId)}
          label={environment.label}
          showLabel={environments.length > 1}
        />
      ))}
    </SettingsSection>
  );
}
