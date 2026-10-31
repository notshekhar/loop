/**
 * The app running on top of this engine.
 *
 * loop is the default app. Another product can embed the same engine and TUI
 * with its own tools, prompt and home directory while still sharing loop's
 * providers, logins and models — those stay in getConfigDir(). Everything the
 * app owns (sessions, skills, sql datasources, the settings it keeps to
 * itself) lives in `dataDir`.
 *
 * Set once, at startup, before the first turn or command list is built. Every
 * reader resolves it at call time, so nothing has to be imported in order.
 */
import type { Tool } from "ai";
import { join } from "node:path";
import { getConfigDir, PRODUCT_NAME } from "./brand";
import { datasourcesStore, settingsStore, type SettingsOverlay } from "./auth/storage";
import type { SlashCommand } from "./commands";
import type { AppSettings } from "./settings";
import type { ToolContext } from "./tools";

export interface AppProfile {
    /** Name the app calls itself in titles and prompts. */
    name: string;
    /** The app's own state. Shared state (auth, providers, models) never moves. */
    dataDir: string;
    /**
     * The turn's base toolset in place of loop's file tools. MCP, skill and
     * the setting-gated tools are still added on top, by their own gates.
     */
    createTools?: (ctx: ToolContext) => Record<string, Tool>;
    /** Persona that replaces loop's coding-agent prompt. Read every turn, so an edit applies on the next one. */
    basePrompt?: () => string;
    /** Settings pinned to a value the user cannot change, e.g. a feature the app does not offer. */
    fixedSettings?: Partial<AppSettings>;
    /** /settings rows the app does not offer, beyond its fixed settings (which are never offered). */
    hiddenSettings?: readonly string[];
    /** Settings stored in `dataDir/settings.json` instead of the shared file. */
    ownSettings?: readonly (keyof AppSettings)[];
    /** Skill directories in place of loop's user + project ones. */
    skillDirs?: readonly string[];
    /** Prefix of a skill's slash command: `/skill:name` in loop, `/name` with "". */
    skillCommandPrefix?: string;
    /** Builtin slash commands the app does not offer. */
    hiddenCommands?: readonly string[];
    /** The app's own slash commands, registered after the builtins they may replace. */
    commands?: readonly SlashCommand[];
    /** Whether named agents (plan, data-analyst, ~/.loop/agents) are offered. */
    agents?: boolean;
    /** Whether installed and builtin extensions load. */
    extensions?: boolean;
}

const LOOP: AppProfile = {
    name: PRODUCT_NAME,
    get dataDir() {
        return getConfigDir();
    },
};

let current: AppProfile = LOOP;

export function setAppProfile(profile: AppProfile): void {
    current = profile;
    settingsStore.setOverlay(overlayFor(profile));
    // The sql tool's connections belong to the app, like its sessions.
    datasourcesStore.relocate(join(profile.dataDir, "datasources.json"));
}

/** Back to loop itself — for tests, which share one process across files. */
export function resetAppProfile(): void {
    setAppProfile(LOOP);
}

export function getAppProfile(): AppProfile {
    return current;
}

/** Whether /settings shows this row: not pinned by the app, and not hidden by it. */
export function isSettingOffered(key: string): boolean {
    return !(key in (current.fixedSettings ?? {})) && !current.hiddenSettings?.includes(key);
}

/** Where the running app keeps its own state; ~/.loop for loop itself. */
export function getAppDataDir(): string {
    return current.dataDir;
}

function overlayFor(profile: AppProfile): SettingsOverlay | null {
    if (!profile.fixedSettings && !profile.ownSettings?.length) return null;
    return {
        fixed: { ...profile.fixedSettings },
        ownKeys: new Set(profile.ownSettings ?? []),
        ownPath: join(profile.dataDir, "settings.json"),
        ownId: `${profile.name}-settings`,
    };
}
