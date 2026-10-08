const { withAppBuildGradle } = require("expo/config-plugins");

// Release builds are signed with loop's upload key when the build provides one
// (CI: .github/workflows/mobile.yml), so every APK carries the SAME signature
// and installs over the last. Expo's template signs release with the debug
// keystore, which is generated per machine — each CI build would then be a
// different signer, and Android refuses to update one with another.
//
// The key is read from Gradle properties, never from the repo:
//   loopUploadStoreFile, loopUploadStorePassword, loopUploadKeyAlias,
//   loopUploadKeyPassword   (e.g. -PloopUploadStoreFile=/path/to/key.p12)
// Without them a release build falls back to the debug key, as before.

const MARKER = "// loop: release signing";

const SIGNING_CONFIG = `
        ${MARKER}
        release {
            if (project.hasProperty("loopUploadStoreFile")) {
                storeFile file(project.property("loopUploadStoreFile"))
                storePassword project.property("loopUploadStorePassword")
                keyAlias project.property("loopUploadKeyAlias")
                keyPassword project.property("loopUploadKeyPassword")
            }
        }`;

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    let gradle = nextConfig.modResults.contents;
    if (gradle.includes(MARKER)) return nextConfig;

    // Add the release config beside the template's debug one.
    gradle = gradle.replace(/signingConfigs\s*\{/, (match) => `${match}${SIGNING_CONFIG}`);

    // The release build type uses it when the key was given.
    gradle = gradle.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
      `$1signingConfig project.hasProperty("loopUploadStoreFile") ? signingConfigs.release : signingConfigs.debug`,
    );

    nextConfig.modResults.contents = gradle;
    return nextConfig;
  });
};
