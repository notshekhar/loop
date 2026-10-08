// Web preview only: native builds embed DM Sans through the expo-font config
// plugin (app.config.ts), which does not exist on web, so the browser fell
// back to its serif. Load the same files under the same family names.
import * as Font from "expo-font";

void Font.loadAsync({
  "DMSans-Regular": require("@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf"),
  "DMSans-Medium": require("@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf"),
  "DMSans-Bold": require("@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf"),
}).catch(() => undefined);
