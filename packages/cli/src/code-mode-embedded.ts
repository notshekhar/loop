/**
 * Code Mode's files inside the compiled binary. Bun embeds a `type: "file"`
 * import and evaluates it to a readable path; the worker is a second build
 * entrypoint (build-bin.ts), addressed by its path relative to the build root.
 */
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import { setCodeModeRuntime } from "@notshekhar/loop-core/code-mode-location";

/** build-bin.ts sets this; it is the worker's path under the build `root`. */
declare const __CODE_MODE_WORKER__: string;

setCodeModeRuntime({ wasmPath, workerUrl: __CODE_MODE_WORKER__ });
