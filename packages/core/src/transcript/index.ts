/**
 * loop's transcript protocol — see types.ts. Runtime-import-free, so the
 * desktop and phone apps import it straight from source
 * (`@notshekhar/loop-core/transcript`).
 */
export * from "./types";
export { applyEvent, applyEvents, emptyTranscript } from "./reduce";
export { fromEntries } from "./history";
