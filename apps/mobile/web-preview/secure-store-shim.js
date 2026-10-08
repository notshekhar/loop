// Web preview only (metro.config.js): expo-secure-store has no web build, and
// the saved-hosts catalog and its tokens live in it — so on web the app could
// neither load nor save a host. This keeps them in localStorage instead.
// NOT secure storage: a pairing token here is readable by anything on the
// page's origin. Native builds keep using the iOS Keychain / Android Keystore.
const PREFIX = "loop-web-preview-secure:";

const storage = () => globalThis.localStorage;

module.exports = {
  __esModule: true,
  WHEN_UNLOCKED: "WHEN_UNLOCKED",
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  isAvailableAsync: async () => storage() !== undefined,
  getItemAsync: async (key) => storage()?.getItem(PREFIX + key) ?? null,
  setItemAsync: async (key, value) => {
    storage()?.setItem(PREFIX + key, value);
  },
  deleteItemAsync: async (key) => {
    storage()?.removeItem(PREFIX + key);
  },
  getItem: (key) => storage()?.getItem(PREFIX + key) ?? null,
  setItem: (key, value) => storage()?.setItem(PREFIX + key, value),
};
