import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Unit tests only — the app itself is bundled by Metro. Node environment, as
// upstream ran them; `@loop/*` resolves through tsconfig paths, the same
// aliases Metro and tsc use (scripts/sync-loop-aliases.mjs).
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "ios/**", "android/**"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
