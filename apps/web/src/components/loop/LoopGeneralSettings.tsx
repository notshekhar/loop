/**
 * The General settings panel, driven entirely by loop.
 *
 * Upstream's General panel configured its server: worktree defaults,
 * background-activity profiles, provider update checks, source-control writing
 * style. None of those are loop's settings, and a UI that shows switches for
 * settings the backend does not have is worse than showing none.
 *
 * So every row here is data. `settings.list` returns loop's own allowlist with
 * its own labels and descriptions, and `extension.list` returns its extensions
 * — which means adding a setting or an extension to loop makes it appear here
 * with no edit to this file.
 */
import { PlugIcon, Settings2Icon } from "lucide-react";

import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useLoopSettings } from "./settings";

function EmptyNote({ children }: { children: string }) {
  return <p className="px-3 py-3 text-[13px] text-muted-foreground/80 sm:px-4">{children}</p>;
}

export function LoopGeneralSettings() {
  const { settings, extensions, loading, error, setSetting, setExtensionEnabled } =
    useLoopSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection icon={<Settings2Icon className="size-4" />} title="loop">
        {error ? (
          <EmptyNote>{`loop did not answer: ${error}`}</EmptyNote>
        ) : loading ? (
          <EmptyNote>Reading settings from loop…</EmptyNote>
        ) : settings.length === 0 ? (
          <EmptyNote>loop exposes no settings over RPC.</EmptyNote>
        ) : (
          settings.map((setting) => (
            <SettingsRow
              control={
                <Switch
                  aria-label={setting.label}
                  checked={setting.value}
                  onCheckedChange={(checked) => void setSetting(setting.key, Boolean(checked))}
                />
              }
              description={setting.description ?? ""}
              key={setting.key}
              title={setting.label}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection icon={<PlugIcon className="size-4" />} title="Extensions">
        {error ? null : extensions.length === 0 ? (
          <EmptyNote>No extensions are installed.</EmptyNote>
        ) : (
          extensions.map((extension) => (
            <SettingsRow
              control={
                <Switch
                  aria-label={extension.name}
                  checked={extension.enabled}
                  onCheckedChange={(checked) =>
                    void setExtensionEnabled(extension.name, Boolean(checked))
                  }
                />
              }
              description={
                extension.description ??
                (extension.builtin === true ? "Built in to loop." : "Installed extension.")
              }
              key={extension.name}
              title={extension.name}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
