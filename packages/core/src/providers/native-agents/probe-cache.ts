import { join } from "node:path";
import { getConfigDir } from "../../brand";
import { readJsonFile, updateJsonFile } from "./json-store";

/**
 * Detection results for the native agents (is the CLI installed, is it signed
 * in, which models does the account offer). Probing spawns the CLI, so results
 * live on disk with a TTL and refresh in the background — a stale answer is
 * served instantly while a fresh one is fetched (stale-while-revalidate).
 */
interface Entry<T> {
    value: T;
    ts: number;
}

type Entries = Record<string, Entry<unknown>>;

const FILE = () => join(getConfigDir(), "native-agents.json");
const TTL_MS = 60 * 60 * 1000;
/** Read once for the synchronous peeks; refreshed by every write. */
let mem: Entries | undefined;
const inFlight = new Map<string, Promise<unknown>>();

function load(): Entries {
    mem ??= readJsonFile<Entries>(FILE());
    return mem;
}

function store(key: string, entry: Entry<unknown>): void {
    // Merge into the file as it is now: another loop process may have probed
    // a different agent since this one loaded it.
    mem = updateJsonFile<Entries>(FILE(), (current) => ({ ...current, [key]: entry }));
}

/** Last known value without probing (undefined if never probed). */
export function peekProbe<T>(key: string): T | undefined {
    return load()[key]?.value as T | undefined;
}

/**
 * Cached probe. `refresh` forces a fresh probe (and waits for it); otherwise a
 * cached value is returned at once and re-probed in the background once stale.
 */
export async function cachedProbe<T>(key: string, probe: () => Promise<T>, opts: { refresh?: boolean } = {}): Promise<T> {
    const entry = load()[key] as Entry<T> | undefined;
    const run = (): Promise<T> => {
        const pending = inFlight.get(key) as Promise<T> | undefined;
        if (pending) return pending;
        const p = probe()
            .then((value) => {
                store(key, { value, ts: Date.now() });
                return value;
            })
            .finally(() => inFlight.delete(key));
        inFlight.set(key, p);
        return p;
    };
    if (!entry || opts.refresh) return run();
    if (Date.now() - entry.ts > TTL_MS) void run().catch(() => {});
    return entry.value;
}
