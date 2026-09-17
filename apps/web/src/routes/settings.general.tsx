import { createFileRoute } from "@tanstack/react-router";

import { LoopGeneralSettings } from "../components/loop/LoopGeneralSettings";

function SettingsGeneralRoute() {
  // Upstream's GeneralSettingsPanel configured its server; loop's General
  // panel is built from loop's own settings.list. See LoopGeneralSettings.
  return <LoopGeneralSettings />;
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
