/**
 * Breadcrumbs for errors loop deliberately swallows (best-effort persistence,
 * corrupt-line skips, cleanup failures). Silent by default; LOOP_DEBUG=1
 * appends them to ~/.loop/debug.log so field failures are diagnosable without
 * making every best-effort path noisy.
 */
import { getConfigDir, brandEnv } from "./brand";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const enabled = Boolean(brandEnv("DEBUG"));

/** For breadcrumbs that cost something to compute — skip the work when off. */
export function isDebugEnabled(): boolean {
    return enabled;
}

export function debugLog(scope: string, ...parts: unknown[]): void {
    if (!enabled) return;
    try {
        const rendered = parts
            .map((p) => {
                if (p instanceof Error) return p.stack ?? p.message;
                if (typeof p === "string") return p;
                try {
                    return JSON.stringify(p);
                } catch {
                    return String(p);
                }
            })
            .join(" ");
        appendFileSync(join(getConfigDir(), "debug.log"), `${new Date().toISOString()} [${scope}] ${rendered}\n`);
    } catch {
        // The breadcrumb logger itself must never throw.
    }
}
