# loop mobile

A remote control for loop: pair with a machine running `loop serve` (and,
later, a TUI's `/rc`), then work in its sessions from your phone. Nothing runs
on the phone itself. See [docs/mobile.md](../../docs/mobile.md).

Forked from T3 Code's mobile app — see [NOTICE.md](NOTICE.md).

## Run it in the iOS Simulator

The app has its own native modules, so it needs a development build; Expo Go
cannot run it.

One-time setup:

1. Install Xcode from the App Store, then:
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and
   `xcodebuild -runFirstLaunch`.
2. Xcode → Settings → Components → install an iOS Simulator runtime.
3. `brew install cocoapods`.

Then, from the repository root after `bun install`:

```sh
cd apps/mobile
bun run ios:dev        # prebuild + compile the dev client + open the Simulator
bun run dev:client     # later runs: just start Metro; JS reloads live
```

## Android: install the latest build

CI (`.github/workflows/mobile.yml`) builds a signed APK on every push to `main`
that touches the app, and puts it on the **`mobile-latest`** pre-release:
https://github.com/notshekhar/loop/releases/tag/mobile-latest — open it on the
phone, tap the `.apk`, allow installs from the browser. Each build installs over
the last (same signing key, rising version code).

The upload key lives in the repo secrets `ANDROID_UPLOAD_KEYSTORE_BASE64` /
`ANDROID_UPLOAD_KEYSTORE_PASSWORD` (a PKCS12, alias `loop`). Lose it and the
next build cannot update installed copies — keep a backup.

## Run it in the iOS Simulator (one command)

With Xcode, an iOS Simulator runtime and CocoaPods installed:

```sh
cd apps/mobile
bun run dev:client      # Metro, in one terminal
bun run ios:sim         # build, install and open on an iPhone Simulator
```

`scripts/ios-sim.sh` explains each step it takes over plain `expo run:ios`:
iCloud-synced folders break codesigning, signing must stay on for the
keychain, and Metro is opened by launch argument rather than URL.

## Preview it in a browser (no Xcode)

```sh
cd apps/mobile && bun run web:preview   # then open http://localhost:8099
```

Use the browser's phone-sized device mode. This is the same app through
react-native-web, for looking at screens and the pairing flow — not how it
ships. Native-only pieces are stubbed (`metro.config.js`, `web-preview/`): the
terminal, native markdown, SwiftUI controls and widgets render as nothing or
plain text, and saved hosts sit in localStorage, not the keychain.

## Pair with a loop

On the machine: `loop serve` (add `--host 0.0.0.0` for the LAN, or reach it
over Tailscale). In the app, add a host and paste the URL it prints
(`http://<host>:5667/?token=…`) or scan its QR code. The Simulator shares the
Mac's network, so `http://127.0.0.1:5667/?token=…` works there.

## Checks

```sh
./node_modules/.bin/tsc --noEmit -p .                          # typecheck
APP_VARIANT=development ./node_modules/.bin/expo export --platform ios   # bundle
```

After `apps/web/tsconfig.json` gains an alias: `node scripts/sync-loop-aliases.mjs`.
