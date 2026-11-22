/** Bun evaluates a `type: "file"` import to the file's path (embedded in a compiled binary). */
declare module "quickjs-wasi/quickjs.wasm" {
    const path: string;
    export default path;
}
