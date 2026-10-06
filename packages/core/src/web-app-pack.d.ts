/**
 * The desktop app's UI, packed (see rpc/web-app-pack.ts). Provided only by a
 * release build's plugin (build-web-app.ts); a source run has no such module,
 * and rpc/serve-web-app.ts treats the failed import as "not embedded".
 */
declare module "loop:web-app-pack" {
    /** Path of the embedded pack file, readable with Bun.file. */
    const path: string;
    export default path;
}
