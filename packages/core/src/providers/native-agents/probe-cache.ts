import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../brand";

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

const FILE = () => join(getConfigDir(), "native-agents.json");
const TTL_MS = 60 * 60 * 1000;
let mem: Record<string, Entry<unknown>> | undefined;
const inFlight = new Map<string, Promise<unknown>>();

function load(): Record<string, Entry<unknown>> {
    if (mem) return mem;
    try {
        mem = JSON.parse(readFileSync(FILE(), "utf8")) as Record<string, Entry<unknown>>;
    } catch {
        mem = {};
    }
    return mem;
}

function save(): void {
    try {
        const dir = getConfigDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = `${FILE()}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(mem ?? {}, null, 2));
        renameSync(tmp, FILE());
    } catch {
        /* cache only */
    }
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
                load()[key] = { value, ts: Date.now() };
                save();
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
