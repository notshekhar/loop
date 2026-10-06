/**
 * Opening things outside the app: editors and the file manager.
 *
 * The renderer owns the editor table (it lives in the contracts, and the UI
 * draws its labels), so this side stays deliberately generic: it answers "which
 * of these commands exist on PATH" and "run this one". Duplicating the table
 * here would mean two lists to keep in step, and the one in the shell would be
 * the one nobody remembered to update.
 *
 * Without this, `shell.openInEditor` failed as unsupported and the server
 * config reported no editors at all, so the "Open in..." menu was permanently
 * empty — there was nothing to detect them with.
 */
import { execFile, spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const WHICH_TIMEOUT_MS = 5_000;

/**
 * Where macOS keeps applications.
 *
 * `/System/Applications` is deliberately absent: nothing shipped with the OS
 * is a code editor, and it is the largest of the three to walk.
 */
const MAC_APP_DIRECTORIES = ["/Applications", join(homedir(), "Applications")];

/**
 * Where an .app keeps a command-line launcher.
 *
 * Electron-based editors (VS Code, VSCodium, Cursor, Trae, Kiro) ship the
 * `code`-style shim inside `Contents/Resources/app/bin`, and it is the same
 * binary that "Install 'code' command in PATH" symlinks. JetBrains IDEs put
 * theirs in `Contents/MacOS`. Zed's is `Contents/MacOS/cli`, which is why the
 * command name is checked against the folder's contents rather than assumed.
 */
const MAC_BUNDLE_BIN_DIRECTORIES = ["Contents/Resources/app/bin", "Contents/MacOS"];

/** Zed's launcher is not named after the command that starts it. */
const MAC_BUNDLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
    zed: ["cli"],
    zeditor: ["cli"],
};

/** Bundle scans are cached: /Applications does not change while a menu is open. */
const BUNDLE_SCAN_TTL_MS = 60_000;
let bundleScan: { at: number; launchers: Promise<Map<string, string>> } | null = null;

async function isExecutable(path: string): Promise<boolean> {
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Whether `bundle` is plausibly the app that `command` names.
 *
 * MEASURED, and the reason this exists: Cursor is a VS Code fork and ships
 * BOTH `cursor` and `code` in its bin directory, so whichever app readdir
 * happened to reach first owned `code` — picking "VS Code" in the menu opened
 * Cursor. Comparing the bundle's own name breaks the tie without a second
 * editor table in the shell: "Visual Studio Code.app" carries `code`, and
 * "Cursor.app" does not.
 */
function bundleOwnsCommand(bundle: string, command: string): boolean {
    return bundle
        .replace(/\.app$/, "")
        .toLowerCase()
        .replaceAll(" ", "")
        .includes(command);
}

/**
 * Every command-line launcher inside the .app bundles under `directories`, by
 * its own name.
 *
 * Read in one pass and cached rather than probed per command: a menu asks
 * about two dozen commands at a time, and each answer would otherwise cost its
 * own walk of every application on the machine.
 */
export async function scanBundleLaunchers(directories: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, { path: string; owned: boolean }>();
    for (const directory of directories) {
        let bundles: string[];
        try {
            bundles = (await readdir(directory)).filter((entry) => entry.endsWith(".app"));
        } catch {
            continue; // ~/Applications does not exist on every machine.
        }
        for (const bundle of bundles) {
            for (const binDirectory of MAC_BUNDLE_BIN_DIRECTORIES) {
                const path = join(directory, bundle, binDirectory);
                let names: string[];
                try {
                    names = await readdir(path);
                } catch {
                    continue;
                }
                for (const name of names) {
                    const owned = bundleOwnsCommand(bundle, name);
                    const existing = found.get(name);
                    // First install otherwise wins, so /Applications beats
                    // ~/Applications the way Launch Services resolves a duplicate.
                    if (existing && !(owned && !existing.owned)) continue;
                    const candidate = join(path, name);
                    if (await isExecutable(candidate)) found.set(name, { path: candidate, owned });
                }
            }
        }
    }
    return new Map([...found].map(([name, entry]) => [name, entry.path]));
}

/** The names a bundled launcher for `command` could go by. */
export function bundleLauncherNames(command: string): readonly string[] {
    return [command, ...(MAC_BUNDLE_ALIASES[command] ?? [])];
}

/**
 * The bundled launcher for `command`, or null.
 *
 * macOS only, and only as a fallback: an app installed by dragging it to
 * /Applications has no shim on PATH until the user runs the editor's own
 * "install the shell command" action, so `which code` said "missing" while
 * VS Code sat right there in /Applications. The menu is meant to say what is
 * installed, not what has been set up for the terminal.
 */
async function findInApplicationBundles(command: string): Promise<string | null> {
    if (process.platform !== "darwin") return null;
    if (!bundleScan || Date.now() - bundleScan.at >= BUNDLE_SCAN_TTL_MS) {
        bundleScan = { at: Date.now(), launchers: scanBundleLaunchers(MAC_APP_DIRECTORIES) };
    }
    const launchers = await bundleScan.launchers;
    for (const name of bundleLauncherNames(command)) {
        const path = launchers.get(name);
        if (path) return path;
    }
    return null;
}

/**
 * Which of `commands` are runnable, mapped to their resolved paths.
 *
 * Uses `which`/`where` rather than walking PATH by hand so shims, aliases in
 * `/usr/local/bin`, and Windows' `.cmd` wrappers all resolve the way the
 * shell would actually run them — then, on macOS, falls back to the launchers
 * inside installed .app bundles.
 */
export async function whichCommands(commands: readonly string[]): Promise<Record<string, string | null>> {
    const finder = process.platform === "win32" ? "where" : "which";
    const entries = await Promise.all(
        [...new Set(commands)].map(async (command) => {
            try {
                const { stdout } = await run(finder, [command], { timeout: WHICH_TIMEOUT_MS });
                const first = stdout
                    .split("\n")
                    .map((line) => line.trim())
                    .find((line) => line !== "");
                if (first) return [command, first] as const;
            } catch {
                // Not on PATH. A normal answer, not a failure.
            }
            return [command, await findInApplicationBundles(command)] as const;
        }),
    );
    return Object.fromEntries(entries);
}

/**
 * Launch a detached process and stop caring about it.
 *
 * Detached with its stdio ignored, and `unref`'d: an editor is a long-lived
 * GUI app, and leaving it as a tracked child would keep pipes open and tie its
 * lifetime to the app the user is about to switch away from.
 */
export async function launch(command: string, args: readonly string[]): Promise<void> {
    // The renderer names the command, not its path — it knows the editor table,
    // not this machine. Resolving here means a bundled launcher that detection
    // found is also the one that runs; spawning the bare name would ENOENT for
    // exactly the editors the .app fallback exists for.
    const resolved = command.includes("/") ? command : ((await whichCommands([command]))[command] ?? command);
    return spawnDetached(resolved, args, command);
}

function spawnDetached(command: string, args: readonly string[], label: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(command, [...args], {
            detached: true,
            stdio: "ignore",
            // `code`, `cursor` and friends are .cmd shims on Windows, which
            // CreateProcess cannot run without a shell.
            shell: process.platform === "win32",
        });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            reject(
                (error as NodeJS.ErrnoException).code === "ENOENT"
                    ? new Error(`${label} is not installed or not on PATH`)
                    : error,
            );
        });
        child.on("spawn", () => {
            if (settled) return;
            settled = true;
            child.unref();
            resolve();
        });
    });
}

/** The OS file manager, for the "Reveal in Finder" style option. */
export function revealCommand(): { command: string; args: readonly string[] } {
    if (process.platform === "darwin") return { command: "open", args: [] };
    if (process.platform === "win32") return { command: "explorer", args: [] };
    return { command: "xdg-open", args: [] };
}
