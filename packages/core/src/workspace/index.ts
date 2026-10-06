/**
 * The workspace a session works in — files, git, terminals, source-control
 * hosts — as one table of named handlers. Hosted by the desktop's utility
 * process and by `loop serve`, so a browser gets the same workspace the
 * desktop app does.
 */
export { createHostHandlers, type HostHandler, type HostServices, type HostTable } from "./hostHandlers";
export { HOST_CALLBACKS, HOST_CHANNELS } from "./channels";
export { TerminalManager, type PtyProcess, type PtySpawner, type TerminalOutput } from "./terminals";
