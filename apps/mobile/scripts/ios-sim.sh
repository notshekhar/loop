#!/usr/bin/env bash
# Build the dev client, install it on an iPhone Simulator, and open it on Metro.
#
#   bun run ios:sim                 # first booted iPhone, or boots "iPhone 17 Pro"
#   SIM="iPhone Air" bun run ios:sim
#
# Why not plain `expo run:ios`, measured on this repo:
#  - ~/Documents is synced by iCloud Drive, which stamps new files with
#    FinderInfo; codesign rejects them ("resource fork, Finder information, or
#    similar detritus not allowed"). Build products go to ~/Library/Caches, and
#    expo-modules-jsi — whose script hardcodes its DerivedData inside
#    node_modules — gets that folder symlinked out too (re-done every run,
#    since `bun install` replaces it).
#  - Signing must stay ON (ad-hoc, no team needed): without entitlements the
#    keychain refuses the app, and saved hosts, tokens and preferences live there.
#  - `--initialUrl` loads Metro directly; opening a URL from outside the app
#    raises an "Open in…?" dialog nothing can tap headlessly.
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE="$HOME/Library/Caches/loop-ios"
mkdir -p "$CACHE/expo-modules-jsi-DerivedData"

JSI_APPLE="$(cd node_modules/expo-modules-jsi/apple 2>/dev/null && pwd -P || true)"
if [ -n "$JSI_APPLE" ] && [ ! -L "$JSI_APPLE/.DerivedData" ]; then
  rm -rf "${JSI_APPLE:?}/.DerivedData"
  ln -s "$CACHE/expo-modules-jsi-DerivedData" "$JSI_APPLE/.DerivedData"
fi

[ -d ios ] || APP_VARIANT=development EXPO_NO_GIT_STATUS=1 npx expo prebuild --platform ios
[ -d ios/Pods ] || (cd ios && pod install)

NAME="${SIM:-iPhone 17 Pro}"
UDID="$(xcrun simctl list devices booted | grep -E "iPhone" | grep -oE '[0-9A-F-]{36}' | head -1)"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available | grep -F "$NAME (" | grep -oE '[0-9A-F-]{36}' | head -1)"
  xcrun simctl boot "$UDID"
fi
open -a Simulator

xcodebuild -workspace ios/loopDev.xcworkspace -scheme loopDev -configuration Debug \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$CACHE/DerivedData" \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
  | grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true

APP="$CACHE/DerivedData/Build/Products/Debug-iphonesimulator/loopDev.app"
xcrun simctl install "$UDID" "$APP"
# The dev menu's first-run sheet would cover the app on every fresh install.
xcrun simctl spawn "$UDID" defaults write com.notshekhar.loop.dev EXDevMenuIsOnboardingFinished -bool YES
curl -sf http://127.0.0.1:8081/status >/dev/null || echo "Start Metro first: bun run dev:client"
xcrun simctl launch --terminate-running-process "$UDID" com.notshekhar.loop.dev --initialUrl "http://127.0.0.1:8081"
