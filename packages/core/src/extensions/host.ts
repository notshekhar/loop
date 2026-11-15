/**
 * The ExtensionHost loads enabled extensions once at startup, hands each an
 * `api` object, and aggregates their contributions for the rest of the app to
 * read (commands, tools, providers, models, agents, skills, turn middleware).
 *
 * Ownership is tracked per extension, so disable/uninstall/reload tears down
 * exactly what an extension added — extensions never clean up after themselves.
 * Loading is in-process dynamic import: the embedded Bun runtime transpiles the
 * extension's TypeScript entry on import (verified to work inside a
 * `bun --compile` binary), and resolves the extension's own node_modules deps.
 *
 * The parts live in `host/`: contribution tracking and teardown, the read-side
 * aggregates (which this class extends), the `api` object factories, and the
 * CLI services with their pre-TUI queue. This class owns loading and lifecycle.
 */
import { getAppProfile } from "../app-profile";
import { EXTENSION_MANIFEST_KEYS, PRODUCT_NAME } from "../brand";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionManifest, ExtensionModule } from "./api";
import { EXTENSION_API_VERSION, requiredApiRange } from "./api";
import { isCompatible, resolveEntry, resolvePkgDir } from "./manifest";
import { getBuiltinEnabled, listRecords, type ExtensionRecord } from "./store";
import { BUILTIN_EXTENSIONS, getBuiltin, type BuiltinExtension } from "./builtin";
import { ContributionAggregates } from "./host/aggregates";
import { emptyContributions, releaseLiveContributions } from "./host/contributions";
import { makeExtensionApi } from "./host/make-api";
import { PendingUiQueue, type HostServices } from "./host/services";

export { applyCommandOps } from "./host/contributions";
export type { HostServices } from "./host/services";

/** One row of the /extensions panel — a built-in or an installed external. */
export interface ExtensionListEntry {
    name: string;
    displayName: string;
    description?: string;
    enabled: boolean;
    builtin: boolean;
    version?: string;
    source?: string;
    linkPath?: string;
}

export class ExtensionHost extends ContributionAggregates {
    /** Per-extension status reporters (api.extension.setStatus), for the banner/panel. */
    private statusFns = new Map<string, () => string | undefined>();
    private initialized = false;
    /** Warnings keyed by extension, so a reload replaces (not appends to) its entries. */
    private warnings = new Map<string, string[]>();
    /** CLI-injected UI/browser bridge (see HostServices). Set before init(). */
    private services: HostServices = {};
    /** Widgets and key bindings asked for before the TUI existed (see PendingUiQueue). */
    private pendingUi = new PendingUiQueue();

    /**
     * Inject UI/browser capabilities from the CLI layer. Call before `init()`:
     * the interactive app passes a real `ui`; print mode passes only
     * `openExternal`, leaving `api.ui` to throw.
     */
    setServices(services: HostServices): void {
        // Merge so the CLI can inject `openExternal` before init() and the
        // interactive `ui` later (once the TUI/deps exist) without clobbering.
        this.services = { ...this.services, ...services };
        this.pendingUi.flush(this.services);
    }

    private warn(name: string, message: string): void {
        const list = this.warnings.get(name) ?? [];
        list.push(message);
        this.warnings.set(name, list);
    }

    /** Load every enabled extension. Safe to call once per session. */
    async init(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        this.warnings.clear();
        // An embedding app that turned extensions off gets none, not even
        // the bundled ones: they are written for loop's own tools and UI.
        if (getAppProfile().extensions === false) return;
        // Built-in (bundled) extensions first, so an external install can still
        // override/extend afterwards. Each is opt-in (default disabled).
        for (const b of BUILTIN_EXTENSIONS) {
            if (!getBuiltinEnabled(b.name, b.defaultEnabled)) continue;
            try {
                await this.loadBuiltin(b);
            } catch (err) {
                this.warn(b.name, `built-in extension "${b.name}" failed to load: ${(err as Error).message}`);
            }
        }
        for (const record of listRecords()) {
            if (!record.enabled) continue;
            try {
                await this.loadOne(record);
            } catch (err) {
                this.warn(record.name, `extension "${record.name}" failed to load: ${(err as Error).message}`);
            }
        }
    }

    /** Activate a bundled extension from its statically-imported module. */
    private async loadBuiltin(b: BuiltinExtension): Promise<void> {
        const record: ExtensionRecord = {
            name: b.name,
            version: "built-in",
            source: "built-in",
            sourceKind: "builtin",
            enabled: true,
            installedAt: 0,
        };
        const manifest: ExtensionManifest = {
            name: b.name,
            [EXTENSION_MANIFEST_KEYS[0]]: { displayName: b.displayName },
        };
        await this.activate(record, manifest, "", b.module);
    }

    private async loadOne(record: ExtensionRecord): Promise<void> {
        const pkgDir = resolvePkgDir(record);
        const manifest = readCompatibleManifest(pkgDir);
        const entry = resolveEntry(pkgDir, manifest);
        if (!existsSync(entry)) throw new Error(`entry not found: ${entry}`);

        // file:// keeps absolute paths importable on Windows; the ?t= query
        // busts the ESM registry so /reload picks up edited code (each reload
        // keeps the old module instance alive — acceptable for a dev loop).
        const entryUrl = pathToFileURL(entry);
        entryUrl.searchParams.set("t", String(Date.now()));
        const imported = (await import(entryUrl.href)) as { default?: ExtensionModule } & ExtensionModule;
        const module: ExtensionModule = imported.default ?? imported;
        await this.activate(record, manifest, pkgDir, module);
    }

    /** Hand the module a fresh `api`, run its activate, and record it as loaded. */
    private async activate(
        record: ExtensionRecord,
        manifest: ExtensionManifest,
        pkgDir: string,
        module: ExtensionModule,
    ): Promise<void> {
        const contributions = emptyContributions();
        const api = makeExtensionApi({
            record,
            manifest,
            pkgDir,
            contributions,
            services: () => this.services,
            pendingUi: this.pendingUi,
            setStatus: (fn) => this.statusFns.set(record.name, fn),
            // Info-level: routes to the chat as a dim system line, not a red error.
            log: (...args: unknown[]) => console.log(`[${record.name}]`, ...args),
        });
        await module.activate?.(api);
        this.loaded.set(record.name, { record, manifest, pkgDir, module, contributions });
    }

    /** Unload one extension, running its deactivate and dropping its contributions. */
    async unload(name: string): Promise<void> {
        const l = this.loaded.get(name);
        if (!l) return;
        try {
            await l.module.deactivate?.();
        } catch (err) {
            this.warn(name, `extension "${name}" deactivate threw: ${(err as Error).message}`);
        }
        releaseLiveContributions(l.contributions);
        this.loaded.delete(name);
        this.statusFns.delete(name);
    }

    /** Reload one extension (pick up edits / re-enable). Handles built-ins too. */
    async reload(name: string): Promise<void> {
        await this.unload(name);
        // A reload's outcome replaces whatever the previous load/unload reported.
        this.warnings.delete(name);
        const builtin = getBuiltin(name);
        if (builtin) {
            if (getBuiltinEnabled(builtin.name, builtin.defaultEnabled)) await this.loadBuiltin(builtin);
            return;
        }
        const record = listRecords().find((r) => r.name === name);
        if (record?.enabled) await this.loadOne(record);
    }

    /**
     * Re-run every loaded extension from disk — what `/reload` needs so an
     * edited extension (files a user or an agent may write mid-session) takes
     * effect without restarting loop.
     *
     * Each is unloaded and loaded again, so `deactivate` runs and long-lived
     * resources are released: an LSP server is shut down and re-provisioned on
     * next use, which is the intended cost of an explicit hard reload.
     */
    async reloadAll(): Promise<void> {
        for (const name of [...this.loaded.keys()]) await this.reload(name);
    }

    /** Deactivate every loaded extension (app shutdown). Safe to re-init after. */
    async close(): Promise<void> {
        for (const name of [...this.loaded.keys()]) await this.unload(name);
        this.initialized = false;
        this.warnings.clear();
    }

    /**
     * One line per currently-loaded extension for the startup banner / panel:
     * "displayName — status" (status from api.extension.setStatus, if set).
     */
    activeStatuses(): string[] {
        const out: string[] = [];
        for (const name of this.loaded.keys()) {
            let status: string | undefined;
            try {
                status = this.statusFns.get(name)?.();
            } catch {
                status = undefined;
            }
            // Short name + terse status, e.g. "ponytail (full)" — stays compact
            // even with many extensions loaded.
            out.push(status ? `${name} (${status})` : name);
        }
        return out;
    }

    getWarnings(): string[] {
        return [...this.warnings.values()].flat();
    }

    /** Unified list for the /extensions panel: built-ins + installed externals. */
    listAll(): ExtensionListEntry[] {
        const out: ExtensionListEntry[] = BUILTIN_EXTENSIONS.map((b) => ({
            name: b.name,
            displayName: b.displayName,
            description: b.description,
            enabled: getBuiltinEnabled(b.name, b.defaultEnabled),
            builtin: true,
        }));
        for (const r of listRecords()) {
            out.push({
                name: r.name,
                displayName: r.name,
                enabled: r.enabled,
                builtin: false,
                version: r.version,
                source: r.source,
                linkPath: r.linkPath,
            });
        }
        return out;
    }
}

/** An installed extension's package.json, refused when it needs another API version. */
function readCompatibleManifest(pkgDir: string): ExtensionManifest {
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) throw new Error(`missing package.json at ${pkgDir}`);
    const manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as ExtensionManifest;
    if (!isCompatible(manifest)) {
        throw new Error(`requires ${PRODUCT_NAME} API ${requiredApiRange(manifest)}, host is ${EXTENSION_API_VERSION}`);
    }
    return manifest;
}

let singleton: ExtensionHost | undefined;

export function getExtensionHost(): ExtensionHost {
    if (!singleton) singleton = new ExtensionHost();
    return singleton;
}
