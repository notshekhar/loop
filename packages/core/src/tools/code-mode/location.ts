/**
 * Where Code Mode's worker entry and `quickjs.wasm` live, for builds that move
 * them: the compiled binary embeds both, the desktop bundle ships them beside
 * its own bundle. Unset (running from source, or the npm package) means
 * pi-codemode's own files in node_modules.
 *
 * Its own module with no imports, exported as
 * `@notshekhar/loop-core/code-mode-location`, so a build's entry can set it
 * without evaluating the rest of core — the CLI keeps `--version` instant.
 */
export interface CodeModeRuntimeLocation {
    wasmPath?: string;
    workerUrl?: string | URL;
}

let location: CodeModeRuntimeLocation = {};

/** Called once at startup by a build that relocates the worker or the wasm. */
export function setCodeModeRuntime(next: CodeModeRuntimeLocation): void {
    location = next;
}

export function getCodeModeRuntime(): CodeModeRuntimeLocation {
    return location;
}
