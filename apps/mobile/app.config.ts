import type { ExpoConfig } from "expo/config";

/**
 * loop's mobile app: a remote control for loop hosts (see docs/mobile.md).
 *
 * Forked from T3 Code's mobile app (apps/web/NOTICE.md). Left out of this
 * config for now, and why:
 *
 *   - T3's cloud sign-in (Clerk), relay and EAS/OTA project — loop pairs with
 *     a host directly (`loop serve` / `/rc`) and reaches it over Tailscale.
 *   - The widget and share extensions — both need App Groups, which need a
 *     paid Apple team; the simulator and a personal team build without them.
 */

type AppVariant = "development" | "preview" | "production";

function resolveAppVariant(value: string | undefined): AppVariant {
  return value === "development" || value === "preview" || value === "production"
    ? value
    : "production";
}

const APP_VARIANT = resolveAppVariant(process.env.APP_VARIANT);

/** Override with your own reverse-DNS id to sign for a device. */
const BASE_BUNDLE_ID = process.env.LOOP_IOS_BUNDLE_ID?.trim() || "com.notshekhar.loop";

const APP_ICON = "../../branding/icon-1024.png";

const VARIANT_CONFIG = {
  development: { appName: "loop Dev", scheme: "loop-dev", idSuffix: ".dev" },
  preview: { appName: "loop Preview", scheme: "loop-preview", idSuffix: ".preview" },
  production: { appName: "loop", scheme: "loop", idSuffix: "" },
} as const;

const variant = VARIANT_CONFIG[APP_VARIANT];
const bundleIdentifier = `${BASE_BUNDLE_ID}${variant.idSuffix}`;

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const config: ExpoConfig = {
  name: variant.appName,
  slug: "loop",
  // Web is a preview only (`LOOP_MOBILE_WEB=1`): the native modules have no
  // web build, so screens render but the terminal, native markdown and widgets
  // do not. The app ships for iOS and Android.
  platforms: process.env.LOOP_MOBILE_WEB === "1" ? ["ios", "android", "web"] : ["ios", "android"],
  scheme: variant.scheme,
  version: "0.1.8",
  orientation: "portrait",
  icon: APP_ICON,
  userInterfaceStyle: "automatic",
  updates: { enabled: false },
  ios: {
    icon: APP_ICON,
    supportsTablet: true,
    bundleIdentifier,
    infoPlist: {
      // Hosts are reached by IP or Tailscale name over plain http/ws; loop
      // does not run its own TLS (Tailscale provides it).
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription:
        "Allow loop to connect to loop hosts on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    icon: APP_ICON,
    package: bundleIdentifier,
    // Every CI build counts up (the workflow passes its run number), so a new
    // APK installs over the last one instead of being refused as a downgrade.
    versionCode: Number(process.env.LOOP_ANDROID_VERSION_CODE) || 1,
    // loop's glyphs on its plate colour (branding/loop-icon.svg without the
    // plate); the launcher draws the shape.
    adaptiveIcon: {
      backgroundColor: "#FCFCFC",
      foregroundImage: "./assets/android-icon-mark.png",
      monochromeImage: "./assets/android-icon-mark.png",
    },
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    "expo-asset",
    [
      "expo-font",
      {
        ios: { fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold] },
        android: {
          fonts: [
            { fontFamily: "DMSans-Regular", fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }] },
            { fontFamily: "DMSans-Medium", fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }] },
            { fontFamily: "DMSans-Bold", fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }] },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    [
      "expo-notifications",
      {
        icon: "./assets/android-notification-icon.png",
        color: "#1B4ED8",
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    "expo-web-browser",
    "expo-quick-actions",
    [
      "expo-camera",
      {
        cameraPermission: "Allow loop to use the camera to scan a host's pairing QR code.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: APP_ICON,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 160,
        dark: { image: APP_ICON, backgroundColor: "#0a0a0a" },
      },
    ],
    ["expo-build-properties", { ios: { deploymentTarget: "18.0" } }],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    "./plugins/withIosSceneLifecycle.cjs",
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidReleaseSigning.cjs",
    "./plugins/withAndroidFbjniPin.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: false,
    // Read by code still carried from upstream; null means "not configured".
    relay: { url: null },
    clerk: { publishableKey: null, jwtTemplate: null },
    observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
  },
};

export default config;
