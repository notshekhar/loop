const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mobileShikiRoot = path.dirname(require.resolve("shiki/package.json", { paths: [__dirname] }));
const resolveShikiDependencyRoot = (packageName) => {
  const entryPath = require.resolve(packageName, { paths: [mobileShikiRoot] });
  let currentDir = path.dirname(entryPath);

  while (!fs.existsSync(path.join(currentDir, "package.json"))) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not resolve package root for ${packageName}`);
    }
    currentDir = parentDir;
  }

  return currentDir;
};

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver = {
  ...config.resolver,
  blockList: [
    ...(Array.isArray(config.resolver?.blockList)
      ? config.resolver.blockList
      : config.resolver?.blockList
        ? [config.resolver.blockList]
        : []),
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.t3[/\\\\].*`),
  ],
  extraNodeModules: {
    // oxlint-disable-next-line unicorn/no-useless-fallback-in-spread
    ...(config.resolver?.extraNodeModules ?? {}),
    shiki: mobileShikiRoot,
    "@shikijs/core": resolveShikiDependencyRoot("@shikijs/core"),
    "@shikijs/engine-javascript": resolveShikiDependencyRoot("@shikijs/engine-javascript"),
    "@shikijs/engine-oniguruma": resolveShikiDependencyRoot("@shikijs/engine-oniguruma"),
    "@shikijs/langs": resolveShikiDependencyRoot("@shikijs/langs"),
    "@shikijs/themes": resolveShikiDependencyRoot("@shikijs/themes"),
    "@shikijs/types": resolveShikiDependencyRoot("@shikijs/types"),
    "@shikijs/vscode-textmate": resolveShikiDependencyRoot("@shikijs/vscode-textmate"),
  },
};

// Web preview: expo-sqlite runs as WebAssembly in the browser, which needs the
// .wasm served as an asset and the page cross-origin isolated (Expo's setup).
config.resolver.assetExts = [...new Set([...(config.resolver.assetExts ?? []), "wasm"])];
config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => (req, res, next) => {
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    return middleware(req, res, next);
  },
};

const uniwindConfig = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  polyfills: { rem: 14 },
});

// Web preview only: Uniwind redirects every react-native-web component it
// lists to its own `uniwind/components/<Name>`, but lists `InputAccessoryView`
// without shipping a web build of it — and react-native-web 0.21.3 exports one.
// A redirect that resolves to nothing falls back to the original module.
const uniwindResolveRequest = uniwindConfig.resolver.resolveRequest;
const NATIVE_ONLY_UI = /^(@expo\/ui\/(swift-ui|jetpack-compose)|react-native-nitro-modules|react-native-nitro-markdown)(\/|$)/;
const nativeUiStub = path.join(__dirname, "web-preview/native-ui-stub.js");
uniwindConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && NATIVE_ONLY_UI.test(moduleName)) {
    return { type: "sourceFile", filePath: nativeUiStub };
  }
  if (platform === "web" && moduleName === "expo-secure-store") {
    return { type: "sourceFile", filePath: path.join(__dirname, "web-preview/secure-store-shim.js") };
  }
  try {
    return uniwindResolveRequest(context, moduleName, platform);
  } catch (error) {
    if (platform !== "web") throw error;
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch {
      // A native-only module (an .ios/.android file pair, no web build): the
      // preview renders without it rather than not at all.
      console.warn(`[web preview] no web build of ${moduleName}; stubbed`);
      return { type: "empty" };
    }
  }
};

module.exports = uniwindConfig;
