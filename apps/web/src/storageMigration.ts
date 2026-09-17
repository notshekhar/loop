// Compatibility identifiers live here so rebranding does not discard saved data.
export const LEGACY_STORAGE_PREFIX = "t3code";

// IndexedDB names are persistent identities. Keep existing connections and keys.
export const CONNECTION_DATABASE_NAME = `${LEGACY_STORAGE_PREFIX}:connection-runtime`;
export const CLOUD_AUTH_DATABASE_NAME = `${LEGACY_STORAGE_PREFIX}:cloud-auth`;

export function migrateLocalStorage(storage: Storage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (
      !key ||
      ![":", ".", "-"].some((separator) => key.startsWith(`${LEGACY_STORAGE_PREFIX}${separator}`))
    ) {
      continue;
    }
    const target = `loop${key.slice(LEGACY_STORAGE_PREFIX.length)}`;
    try {
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(target) === null) {
        storage.setItem(target, value);
      }
      storage.removeItem(key);
    } catch {
      // Leave the original intact and retry on the next launch (e.g. quota errors).
    }
  }
}

if (typeof window !== "undefined") {
  try {
    migrateLocalStorage(window.localStorage);
  } catch {
    // Storage may be unavailable; the app can still start with its defaults.
  }
}
