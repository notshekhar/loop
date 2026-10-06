/**
 * The desktop app's UI (`apps/web`'s build) as one file, so release builds can
 * carry it: a compiled binary has no directory tree to serve from, and an npm
 * install should not unpack six hundred assets to serve one page.
 *
 * Format — gzip of:  [u32 header length][header JSON][file bytes…]
 * where the header is `[{ path, offset, length }]` into the bytes after it.
 * Read once, when serve starts; a plain `loop` never touches it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

interface PackEntry {
    path: string;
    offset: number;
    length: number;
}

/**
 * Files the browser never asks for. Source maps are 2/3 of the build by
 * weight; the mock service worker is the app's test harness.
 */
function shipped(path: string): boolean {
    return !path.endsWith(".map") && path !== "/mockServiceWorker.js";
}

/** Pack the build in `dir` (an `apps/web/dist`). Build-time only. */
export function packWebApp(dir: string): Uint8Array {
    const files: { path: string; data: Uint8Array }[] = [];
    const walk = (current: string): void => {
        for (const name of readdirSync(current).sort()) {
            const full = join(current, name);
            if (statSync(full).isDirectory()) {
                walk(full);
                continue;
            }
            const path = "/" + relative(dir, full).split(sep).join("/");
            if (shipped(path)) files.push({ path, data: readFileSync(full) });
        }
    };
    walk(dir);
    if (!files.some((f) => f.path === "/index.html")) throw new Error(`${dir} has no index.html — not a web build`);

    const header: PackEntry[] = [];
    let offset = 0;
    for (const f of files) {
        header.push({ path: f.path, offset, length: f.data.length });
        offset += f.data.length;
    }
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(4 + headerBytes.length + offset);
    new DataView(out.buffer).setUint32(0, headerBytes.length);
    out.set(headerBytes, 4);
    let at = 4 + headerBytes.length;
    for (const f of files) {
        out.set(f.data, at);
        at += f.data.length;
    }
    return Bun.gzipSync(out, { level: 9 });
}

/** The files of a pack, by URL path (`/index.html`, `/assets/…`). */
export function unpackWebApp(packed: Uint8Array<ArrayBuffer>): Map<string, Uint8Array<ArrayBuffer>> {
    const raw = Bun.gunzipSync(packed);
    const headerLength = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0);
    const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + headerLength))) as PackEntry[];
    const body = 4 + headerLength;
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const e of header) files.set(e.path, raw.subarray(body + e.offset, body + e.offset + e.length));
    return files;
}
