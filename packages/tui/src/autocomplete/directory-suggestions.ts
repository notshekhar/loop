import { type Dirent, readdirSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import type { AutocompleteItem } from "./types";
import { buildCompletionValue, expandHomePath, parsePathPrefix, toDisplayPath } from "./path-token";

/**
 * Plain path completion (Tab, `./`, `~/`, `/…`): list one directory and keep
 * the entries whose names start with what has been typed of the last segment.
 */

/** The directory to list and the start of the name to match in it. */
function resolveSearch(rawPrefix: string, basePath: string): { searchDir: string; searchPrefix: string } {
    // Handle home directory expansion
    const expandedPrefix = rawPrefix.startsWith("~") ? expandHomePath(rawPrefix) : rawPrefix;
    const isAnchored = rawPrefix.startsWith("~") || expandedPrefix.startsWith("/");
    const resolveDir = (dir: string) => (isAnchored ? dir : join(basePath, dir));

    // A bare root ("", "~") or a prefix ending in "/" lists that directory whole.
    if (rawPrefix === "" || rawPrefix === "~" || rawPrefix.endsWith("/")) {
        return { searchDir: resolveDir(expandedPrefix), searchPrefix: "" };
    }

    // Split into directory and file prefix
    return { searchDir: resolveDir(dirname(expandedPrefix)), searchPrefix: basename(expandedPrefix) };
}

/** A directory, or a symlink pointing to one. */
function isDirectoryEntry(entry: Dirent, searchDir: string): boolean {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
        return statSync(join(searchDir, entry.name)).isDirectory();
    } catch {
        // Broken symlink or permission error - treat as file
        return false;
    }
}

/** The path to write back for `name`, in the same form the user typed the prefix. */
function completionPathFor(displayPrefix: string, name: string): string {
    if (displayPrefix.endsWith("/")) {
        // If prefix ends with /, append entry to the prefix
        return displayPrefix + name;
    }
    if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
        // Preserve ~/ format for home directory paths
        if (displayPrefix.startsWith("~/")) {
            const dir = dirname(displayPrefix.slice(2));
            return `~/${dir === "." ? name : join(dir, name)}`;
        }
        if (displayPrefix.startsWith("/")) {
            // Absolute path - construct properly
            const dir = dirname(displayPrefix);
            return dir === "/" ? `/${name}` : `${dir}/${name}`;
        }
        const relativePath = join(dirname(displayPrefix), name);
        // path.join normalizes away ./ prefix, preserve it
        return displayPrefix.startsWith("./") && !relativePath.startsWith("./") ? `./${relativePath}` : relativePath;
    }
    // For standalone entries, preserve ~/ if original prefix was ~/
    return displayPrefix.startsWith("~") ? `~/${name}` : name;
}

/** Directories first, then alphabetically. */
function compareDirectoriesFirst(a: AutocompleteItem, b: AutocompleteItem): number {
    const aIsDir = a.value.endsWith("/");
    const bIsDir = b.value.endsWith("/");
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.label.localeCompare(b.label);
}

/** File/directory suggestions for a path prefix; [] when the directory can't be read. */
export function getDirectorySuggestions(prefix: string, basePath: string): AutocompleteItem[] {
    try {
        const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
        const { searchDir, searchPrefix } = resolveSearch(rawPrefix, basePath);
        const suggestions: AutocompleteItem[] = [];

        for (const entry of readdirSync(searchDir, { withFileTypes: true })) {
            if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
                continue;
            }
            const isDirectory = isDirectoryEntry(entry, searchDir);
            const relativePath = toDisplayPath(completionPathFor(rawPrefix, entry.name));
            const pathValue = isDirectory ? `${relativePath}/` : relativePath;
            suggestions.push({
                value: buildCompletionValue(pathValue, { isAtPrefix, isQuotedPrefix }),
                label: entry.name + (isDirectory ? "/" : ""),
            });
        }

        return suggestions.sort(compareDirectoriesFirst);
    } catch {
        // Directory doesn't exist or not accessible
        return [];
    }
}
