/**
 * The machines this loop has paired with, isolated in its own module so tests
 * can mock it in-memory (same pattern as serve-token-store). Kept in auth.json
 * next to provider credentials: each entry carries the other machine's serve
 * token, which is full control of it.
 */
import { authStore } from "../auth/storage";

export interface RemoteHostRecord {
    /** The host's environment id (serve-pairing.ts) — stable for its token. */
    readonly id: string;
    /** What the host calls itself (its hostname), unless renamed here. */
    readonly label: string;
    /** Base URL, no path or token: `http://studio.tail1234.ts.net:5667`. */
    readonly url: string;
    readonly token: string;
    readonly addedAt: number;
}

const KEY = "remoteHosts";

export function loadRemoteHosts(): RemoteHostRecord[] {
    const v = authStore.get(KEY);
    if (!Array.isArray(v)) return [];
    return v.filter(
        (h): h is RemoteHostRecord =>
            !!h &&
            typeof h === "object" &&
            typeof (h as RemoteHostRecord).id === "string" &&
            typeof (h as RemoteHostRecord).url === "string" &&
            typeof (h as RemoteHostRecord).token === "string",
    );
}

export function saveRemoteHosts(hosts: readonly RemoteHostRecord[]): void {
    authStore.set(KEY, hosts);
}
