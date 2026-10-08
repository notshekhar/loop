# Third-party notice

`apps/mobile` is a fork of the mobile app from **T3 Code**
(<https://github.com/t3-tools/t3code>), taken at upstream commit `94331c58e` —
the same commit `apps/web` was forked from (see `apps/web/NOTICE.md`) — and
used under the MIT License. The upstream license text is kept verbatim in
`LICENSE-t3code`.

The app does not vendor its own copy of upstream's `contracts`, `shared` or
`client-runtime`: it imports the copies `apps/web` already vendors
(`apps/web/src/loop/{contracts,shared,runtime}`), through the same `@loop/*`
aliases (`scripts/sync-loop-aliases.mjs`), so the phone and the web app run one
client.

The React Native patches in the repository root `patches/` that name
`@expo/metro-config`, `@legendapp/list`, `@react-native-menu/menu`,
`@react-navigation/native-stack`, `expo-modules-jsi`,
`react-native-gesture-handler`, `react-native-keyboard-controller`,
`react-native-nitro-modules` and `react-native-screens` are upstream's, taken
at the same commit.

The native modules under `modules/` are upstream's, unchanged, and keep their
own notices.
