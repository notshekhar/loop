import { describe, expect, it } from "vite-plus/test";
import { LEGACY_STORAGE_PREFIX, migrateLocalStorage } from "./storageMigration";

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

describe("storage rebranding", () => {
  it("preserves drafts and preferences across every historical key separator", () => {
    const storage = memoryStorage({
      [`${LEGACY_STORAGE_PREFIX}:composer-drafts:v1`]: '{"draft":"keep me"}',
      [`${LEGACY_STORAGE_PREFIX}.fileExplorerOpen`]: "true",
      [`${LEGACY_STORAGE_PREFIX}-connect-cli-auth-state`]: "auth-state",
      unrelated: "untouched",
    });
    migrateLocalStorage(storage);
    expect(storage.getItem("loop:composer-drafts:v1")).toBe('{"draft":"keep me"}');
    expect(storage.getItem("loop.fileExplorerOpen")).toBe("true");
    expect(storage.getItem("loop-connect-cli-auth-state")).toBe("auth-state");
    expect(storage.getItem("unrelated")).toBe("untouched");
    expect(storage.length).toBe(4);
  });

  it("keeps newer preferences and does not resurrect a cleared draft on restart", () => {
    const storage = memoryStorage({
      [`${LEGACY_STORAGE_PREFIX}:theme`]: "dark",
      "loop:theme": "light",
      [`${LEGACY_STORAGE_PREFIX}:composer-drafts:v1`]: "draft",
    });
    migrateLocalStorage(storage);
    expect(storage.getItem("loop:theme")).toBe("light");
    storage.removeItem("loop:composer-drafts:v1");
    migrateLocalStorage(storage);
    expect(storage.getItem("loop:composer-drafts:v1")).toBeNull();
  });

  it("retains the original when a write fails and retries on the next launch", () => {
    const key = `${LEGACY_STORAGE_PREFIX}:theme`;
    const storage = memoryStorage({ [key]: "dark" });
    const setItem = storage.setItem;
    storage.setItem = () => {
      throw new Error("quota exceeded");
    };
    expect(() => migrateLocalStorage(storage)).not.toThrow();
    expect(storage.getItem(key)).toBe("dark");
    storage.setItem = setItem;
    migrateLocalStorage(storage);
    expect(storage.getItem("loop:theme")).toBe("dark");
    expect(storage.getItem(key)).toBeNull();
  });
});
