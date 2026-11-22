/**
 * Where the model's JavaScript runs: a fresh QuickJS VM (WebAssembly) in its
 * own worker thread per script, via pi-mono's `@earendil-works/pi-codemode`.
 *
 * Not `node:vm`, measured on Bun 1.4.5: a tool function handed into a vm
 * context carries the host realm, so `read.constructor.constructor("return
 * process")()` reaches `process` and `Bun` and every permission check is one
 * line away; and vm's timeout stops nothing once the script has awaited. Inside
 * QuickJS there is no `process`, `Bun`, `require`, timer or network — calling
 * the tools handed in is the only thing a script can do — and the worker can be
 * terminated however the script spins.
 */
import { CodemodeSandbox, loadQuickJSWasm, type CodemodeResult, type CodemodeTool } from "@earendil-works/pi-codemode";
import { getCodeModeRuntime } from "./location";

/** A script that waits on a long build or test gets as long as a bash call may. */
export const SCRIPT_TIMEOUT_MS = 10 * 60_000;

/** A runaway allocation fails inside the script instead of taking loop's memory. */
const SCRIPT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

/** Run one script to its end (returned, threw, timed out or aborted). */
export async function runScript(code: string, tools: CodemodeTool[], signal?: AbortSignal): Promise<CodemodeResult> {
    const location = getCodeModeRuntime();
    const sandbox = new CodemodeSandbox({
        tools,
        timeoutMs: SCRIPT_TIMEOUT_MS,
        memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
        wasm: loadQuickJSWasm(location.wasmPath),
        ...(location.workerUrl ? { workerUrl: location.workerUrl } : {}),
    });
    try {
        return await sandbox.execute(code, signal ? { signal } : {});
    } finally {
        await sandbox.close();
    }
}
