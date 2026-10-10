import "./src/lib/es2023Polyfills";
// A synchronous, SQLite-backed `localStorage`. loop's shared handlers keep
// small durable state there — above all which loop session a chat started
// on the phone became. React Native has none, so the phone forgot it on every
// restart: a chat created here, or a send still waiting in the outbox, then
// pointed at an id the host had never heard of and sat on "Loading messages".
import "expo-sqlite/localStorage/install";
import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";
import "./src/lib/webPreviewFonts";

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(App);
