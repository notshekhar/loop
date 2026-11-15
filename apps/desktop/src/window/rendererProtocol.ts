/**
 * The renderer is served over a custom scheme rather than `file://`.
 *
 * The UI is a single-page app with real paths (`/project/:id`), and `file://`
 * has no notion of a history fallback — a reload on any route but `/` would
 * 404. A registered scheme also gives the page a real origin, which localStorage
 * and the router both need.
 */
import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

export const RENDERER_SCHEME = "app";
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://loop`;

/** Must run before the app is ready — Electron only accepts privileged schemes then. */
export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      // `codeCache`: Chromium only keeps V8's compiled code for schemes that ask.
      // Without it the renderer re-parsed its 5MB of startup JS on every launch
      // — MEASURED 85ms of background parsing that a warm cache removes.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
  ]);
}

/**
 * The app ships every asset it uses, so nothing needs to be fetched from the
 * network. `wasm-unsafe-eval` stays for the bundled WebAssembly modules, and
 * inline styles for the bundled CSS-in-JS.
 *
 * Connections are the exception: Settings → Connections pairs other machines
 * running loop (`loop serve`, `/rc`) and then talks to them directly, at
 * whatever http/ws address or tailnet name the user gave. Scripts still come
 * only from the bundle, so this widens where the app's own code may connect,
 * not what code runs. Same policy as upstream's desktop.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: http: https: ws: wss:",
  "worker-src 'self' blob:",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Serve the renderer bundle from `rendererDirectory` on the app scheme. Call once the app is ready. */
export function handleRendererScheme(rendererDirectory: string): void {
  protocol.handle(RENDERER_SCHEME, (request) => serveRenderer(rendererDirectory, request));
}

async function serveRenderer(rendererDirectory: string, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  // normalize + a prefix check keeps a crafted `..` path inside the bundle.
  const candidate = normalize(join(rendererDirectory, decodeURIComponent(pathname)));
  const insideBundle = candidate.startsWith(rendererDirectory);
  const hasExtension = extname(pathname) !== "";

  // Anything without a file extension is a route, not an asset: hand back the
  // shell and let the router resolve it.
  const target = insideBundle && hasExtension ? candidate : join(rendererDirectory, "index.html");
  try {
    const body = await readFile(target);
    return new Response(body, {
      headers: {
        "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
        "content-security-policy": CONTENT_SECURITY_POLICY,
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
