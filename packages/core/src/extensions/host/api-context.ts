/** What every per-area API factory gets: the extension it serves and the host bits it reaches. */
import type { ExtensionManifest } from "../api";
import type { ExtensionRecord } from "../store";
import type { Contributions } from "./contributions";
import type { HostServices, PendingUiQueue } from "./services";

export interface ApiContext {
    record: ExtensionRecord;
    manifest: ExtensionManifest;
    pkgDir: string;
    /** Where this extension's contributions are recorded, for unload to drop. */
    contributions: Contributions;
    /** Read at call time: the CLI merges services in after activation. */
    services: () => HostServices;
    pendingUi: PendingUiQueue;
    setStatus: (fn: () => string | undefined) => void;
    /** Info-level, prefixed with the extension's name. */
    log: (...args: unknown[]) => void;
}
