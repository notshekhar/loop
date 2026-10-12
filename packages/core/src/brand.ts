/**
 * Single source of truth for the product's name. The product has been renamed
 * before (pi → loop) and may be renamed again, so nothing outside this file may
 * hardcode the brand — no path literals, env-var names, manifest keys, or
 * user-facing strings. Import from here instead.
 *
 * To rename the product: edit the constants below, move the old name into the
 * LEGACY_* lists, then follow RENAME.md at the repo root for the few non-TS
 * touchpoints (package.json, install scripts, workflows, docs regeneration).
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Binary + display name. Keep it a single lowercase token. */
export const PRODUCT_NAME = "loop";

/**
 * How the product names itself where something OTHER than the terminal shows
 * it: a tab title, a cmux pane card, a notification. A session that has earned
 * a title uses that instead — this is the standing name, the one an untitled
 * session falls back to (Claude Code's equivalent is the constant "Claude
 * Code"). Derived so a rename carries it.
 */
export const PRODUCT_TITLE = `${PRODUCT_NAME.charAt(0).toUpperCase()}${PRODUCT_NAME.slice(1)} Agent`;

/** Name of the config dir: ~/<CONFIG_DIR_NAME> globally, <cwd>/<CONFIG_DIR_NAME> per project. */
export const CONFIG_DIR_NAME = `.${PRODUCT_NAME}`;

/** Prefix for every environment variable the product reads (e.g. LOOP_DEBUG). */
export const ENV_PREFIX = PRODUCT_NAME.toUpperCase();

/**
 * package.json keys an extension may use for its manifest section (entry,
 * engines, permissions…). Current name first; when renaming, append the old
 * name so already-published extensions keep loading.
 */
export const EXTENSION_MANIFEST_KEYS: readonly string[] = [PRODUCT_NAME];

/** GitHub repo slug — release downloads, update checks, user-agent. */
export const REPO_SLUG = `notshekhar/${PRODUCT_NAME}`;

/** ~/.loop (or whatever the brand is today). */
export function getConfigDir(): string {
    return join(homedir(), CONFIG_DIR_NAME);
}

/** Full env-var name for a suffix: envName("DEBUG") → "LOOP_DEBUG". */
export function envName(suffix: string): string {
    return `${ENV_PREFIX}_${suffix}`;
}

/** Read a branded env var by suffix: brandEnv("DEBUG") → process.env.LOOP_DEBUG. */
export function brandEnv(suffix: string): string | undefined {
    return process.env[envName(suffix)];
}
