/**
 * The UI `loop serve` hosts: the desktop app's own React app (`apps/web`),
 * whose browser mode speaks serve's `/ws`. One UI for both shells.
 *
 * Where it comes from, first match wins:
 *   1. an explicit build directory (`webAppDir`, or `LOOP_WEB_APP_DIR`);
 *   2. the pack a release build embedded (`loop:web-app-pack`, see
 *      web-app-pack.ts and the build plugin in build-web-app.ts);
 *   3. running from source, the workspace's own `apps/web/dist`.
 */
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unpackWebApp } from "./web-app-pack";

/** One file of the app by URL path (`/index.html`, `/assets/…`), or null. */
export interface WebApp {
    read(path: string): Promise<Blob | Uint8Array<ArrayBuffer> | null>;
}

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
};

function directoryApp(dir: string): WebApp {
    const root = resolve(dir);
    return {
        async read(path) {
            const candidate = normalize(join(root, path));
            // `..` cannot climb out of the build.
            if (!candidate.startsWith(root + sep)) return null;
            const file = Bun.file(candidate);
            return (await file.exists()) ? file : null;
        },
    };
}

function packedApp(files: Map<string, Uint8Array<ArrayBuffer>>): WebApp {
    // A map lookup by exact path cannot traverse: there is no filesystem.
    return { read: async (path) => files.get(posix.normalize(path)) ?? null };
}

/**
 * The embedded pack's path, in a release build. A source run has no such
 * module (the build plugin provides it), and that is not an error.
 */
async function embeddedPackPath(): Promise<string | null> {
    try {
        const mod = (await import("loop:web-app-pack")) as { default: string };
        return mod.default;
    } catch {
        return null;
    }
}

const WORKSPACE_BUILD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "apps", "web", "dist");

/**
 * The app to serve, or null when there is none (a source checkout whose
 * `apps/web` was never built). `explicitDir: null` forces none — for tests.
 */
export async function loadWebApp(explicitDir?: string | null): Promise<WebApp | null> {
    if (explicitDir === null) return null;
    const dir = explicitDir ?? process.env.LOOP_WEB_APP_DIR;
    if (dir) return existsSync(join(dir, "index.html")) ? directoryApp(dir) : null;
    const pack = await embeddedPackPath();
    if (pack) return packedApp(unpackWebApp(new Uint8Array(await Bun.file(pack).arrayBuffer())));
    return existsSync(join(WORKSPACE_BUILD, "index.html")) ? directoryApp(WORKSPACE_BUILD) : null;
}

/**
 * A file from the app, or the app shell for anything without an extension (a
 * client-side route — the router resolves it). The same rule the desktop's
 * renderer protocol uses.
 */
export async function serveWebApp(app: WebApp, pathname: string): Promise<Response> {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return new Response("Not found", { status: 404 });
    }
    const isAsset = extname(decoded) !== "";
    const path = isAsset ? decoded : "/index.html";
    const body = await app.read(path);
    if (!body) return new Response("Not found", { status: 404 });
    return new Response(body, {
        headers: {
            "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
            // Hashed assets never change under the same name; the shell does.
            "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        },
    });
}

/** What serve answers when there is no UI to serve. */
export function webAppMissing(): Response {
    return new Response(
        "loop serve: the web UI is not built. From a source checkout run `bun run --filter @loop/web build`.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
}
