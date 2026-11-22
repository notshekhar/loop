/**
 * The compiled binary's entry (build-bin.ts). Points Code Mode at the worker
 * and wasm embedded in the binary, then starts the CLI.
 *
 * Only the compiled build starts here: from source and in the npm package,
 * pi-codemode finds its own files in node_modules, and a `.wasm` file import
 * means nothing to Node. This file is imported first so the location is set
 * before the CLI module evaluates.
 */
import "./code-mode-embedded";
import "./cli";
