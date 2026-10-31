import Configstore from "configstore";
import { join } from "node:path";
import { getConfigDir, PRODUCT_NAME } from "../brand";

const CONFIG_DIR = getConfigDir();

type StoreData = Record<string, unknown>;

/**
 * configstore reads + JSON-parses the whole file from disk on EVERY `.get`/`.all`
 * and rewrites it on every `.set` — it has no in-memory cache (verified against
 * configstore@7 source: `get all()` calls `readFileSync` each time). In our hot
 * paths that synchronous read blocks the event loop: the agent loop reads ~8
 * settings per turn (plus per subagent), and the footer ticker reads several
 * every second. That blocking I/O is a prime suspect for the UI freezing.
 *
 * CachedStore keeps the parsed object in memory and only touches the disk on a
 * real write. Reads come from the cache; writes go through to configstore (for
 * persistence) and refresh the cache. `refresh()` drops the cache so an external
 * edit to the file is picked up on the next read.
 */
export class CachedStore {
    // Constructed lazily: Configstore writes its defaults file in the
    // constructor, and these stores are module-level singletons — an eager
    // construct would create the config dir at import time, just because
    // something imported this module. No disk I/O until a store is used.
    private _store: Configstore | null = null;
    private cache: StoreData | null = null;

    constructor(
        private readonly id: string,
        private readonly defaults: StoreData,
        private options: { configPath: string },
    ) {}

    /** Point the store at another file; the next read comes from there. */
    relocate(configPath: string): void {
        this.options = { configPath };
        this._store = null;
        this.cache = null;
    }

    private get store(): Configstore {
        if (this._store === null) this._store = new Configstore(this.id, this.defaults, this.options);
        return this._store;
    }

    get all(): StoreData {
        if (this.cache === null) this.cache = this.store.all as StoreData;
        return this.cache;
    }

    set all(value: StoreData) {
        this.store.all = value;
        this.cache = value;
    }

    get(key: string): unknown {
        return this.all[key];
    }

    set(key: string, value: unknown): void {
        this.store.set(key, value);
        // Keep the cache coherent without a re-read. If nothing is cached yet,
        // leave it null so the next read pulls the merged-with-defaults file.
        if (this.cache !== null) this.cache[key] = value;
    }

    delete(key: string): void {
        this.store.delete(key);
        if (this.cache !== null) delete this.cache[key];
    }

    /** Force a re-read on next access — call after an external write to the file. */
    refresh(): void {
        this.cache = null;
    }
}

export const authStore = new CachedStore(
    `${PRODUCT_NAME}-agent-auth`,
    { providers: {}, active: null },
    { configPath: join(CONFIG_DIR, "auth.json") },
);

/**
 * The share of the context window at which a session compacts on its own.
 * 70%, not higher: compaction itself needs room — the summary request is
 * the largest one a session sends — and the turn waiting on it is the
 * user's.
 */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.7;

/** How an embedding app (app-profile.ts) changes what settings read and write. */
export interface SettingsOverlay {
    /** Keys pinned to a value: reads return it and writes are dropped. */
    fixed: StoreData;
    /** Keys kept in the app's own file instead of the shared one. */
    ownKeys: ReadonlySet<string>;
    ownPath: string;
    ownId: string;
}

/**
 * settings.json, with an optional overlay from the embedding app.
 *
 * The overlay lives here rather than in getSetting because the TUI reads and
 * writes settingsStore directly in dozens of places; routing at the store is
 * the one spot every one of them passes through.
 */
class SettingsStore extends CachedStore {
    private overlay: { fixed: StoreData; ownKeys: ReadonlySet<string>; own: CachedStore } | null = null;

    setOverlay(overlay: SettingsOverlay | null): void {
        this.overlay = overlay && {
            fixed: overlay.fixed,
            ownKeys: overlay.ownKeys,
            own: new CachedStore(overlay.ownId, {}, { configPath: overlay.ownPath }),
        };
    }

    override get(key: string): unknown {
        const route = this.route(key);
        if (route === "fixed") return this.overlay?.fixed[key];
        return route === "own" ? this.overlay?.own.get(key) : super.get(key);
    }

    override set(key: string, value: unknown): void {
        const route = this.route(key);
        if (route === "own") this.overlay?.own.set(key, value);
        else if (route === "shared") super.set(key, value);
    }

    override delete(key: string): void {
        const route = this.route(key);
        if (route === "own") this.overlay?.own.delete(key);
        else if (route === "shared") super.delete(key);
    }

    override refresh(): void {
        super.refresh();
        this.overlay?.own.refresh();
    }

    private route(key: string): "fixed" | "own" | "shared" {
        if (!this.overlay) return "shared";
        if (key in this.overlay.fixed) return "fixed";
        return this.overlay.ownKeys.has(key) ? "own" : "shared";
    }
}

export const settingsStore = new SettingsStore(
    `${PRODUCT_NAME}-agent-settings`,
    {
        defaultModel: null,
        theme: "dark",
        maxSteps: 0, // 0 = unlimited; loop ends when the model stops calling tools
        autoCompactThreshold: DEFAULT_AUTO_COMPACT_THRESHOLD,
        workspaceContext: true,
    },
    { configPath: join(CONFIG_DIR, "settings.json") },
);

// Datasources for the data-analyst agent's `sql` tool. Kept in its own file
// (not settings.json) so connection configs stay isolated from app settings.
export const datasourcesStore = new CachedStore(
    `${PRODUCT_NAME}-agent-datasources`,
    { connections: {} },
    { configPath: join(CONFIG_DIR, "datasources.json") },
);

/**
 * Drop every cached config file so the next read comes from disk. This is what
 * a hard reload (`/reload`, `config.reload`) means for the JSON config layer:
 * all three stores are hand-editable — by the user or by the agent, which the
 * internal docs actively tell it to do for custom providers and datasources —
 * so refreshing only settings.json left those edits invisible until a restart.
 * Add any new CachedStore here.
 */
export function refreshConfigStores(): void {
    settingsStore.refresh();
    authStore.refresh();
    datasourcesStore.refresh();
}

// getProjectModel/setProjectModel/getProjectProviderModel moved to
// sessions/projects.ts (the projects table); the auth barrel re-exports them
// so the public surface is unchanged.
