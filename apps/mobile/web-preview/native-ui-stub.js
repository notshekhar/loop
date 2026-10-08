// Web preview only (metro.config.js): stands in for native-only UI packages —
// @expo/ui's SwiftUI and Jetpack Compose views — which look up their native
// view at import and throw on web. Every named export is a component that
// renders its children, so the screens around them still lay out.
const React = require("react");

const Passthrough = ({ children }) => React.createElement(React.Fragment, null, children ?? null);

module.exports = new Proxy(
  { __esModule: true, default: Passthrough },
  {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name !== "string") return undefined;
      // Modifier and helper functions (`frame(...)`, `padding(...)`) are called
      // rather than rendered; a function that returns an inert value covers both.
      return Passthrough;
    },
  },
);
