const { withProjectBuildGradle } = require("expo/config-plugins");

// Pin fbjni to the version React Native and Hermes are built against.
//
// react-native-shiki-engine declares `com.facebook.fbjni:fbjni:+`, and Gradle
// resolves "+" to the newest fbjni (0.8.1). That build of libfbjni.so links
// against an NDK 28 libc++, while the app ships NDK 27's libc++_shared.so
// (React Native 0.85's NDK) — which has no `__cxa_init_primary_exception`. So
// the release APK died on launch, before any JavaScript ran:
//   dlopen failed: cannot locate symbol "__cxa_init_primary_exception"
//   referenced by ".../lib/arm64-v8a/libfbjni.so"
// Forcing the version React Native asks for keeps one C++ runtime throughout.

const FBJNI_VERSION = "0.7.0";
const MARKER = "// loop: pin fbjni";

module.exports = function withAndroidFbjniPin(config) {
  return withProjectBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.contents.includes(MARKER)) return nextConfig;
    nextConfig.modResults.contents += `
${MARKER} (plugins/withAndroidFbjniPin.cjs)
allprojects {
    configurations.all {
        resolutionStrategy.force "com.facebook.fbjni:fbjni:${FBJNI_VERSION}"
    }
}
`;
    return nextConfig;
  });
};
