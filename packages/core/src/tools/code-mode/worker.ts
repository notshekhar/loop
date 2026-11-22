/**
 * The code-mode worker thread's entry. Importing pi-codemode's worker starts
 * it. A bundled build (compiled binary, desktop) builds this file as its own
 * entrypoint and points `setCodeModeRuntime({ workerUrl })` at it, because the
 * package's default worker path is resolved relative to a module that the
 * bundle no longer has on disk.
 */
import "@earendil-works/pi-codemode/worker";
