import { applyCompletion } from "./autocomplete/apply-completion";
import { getDirectorySuggestions } from "./autocomplete/directory-suggestions";
import { getFuzzyFileSuggestions } from "./autocomplete/fuzzy-file-suggestions";
import { extractAtPrefix, extractPathPrefix, parsePathPrefix } from "./autocomplete/path-token";
import { type CommandEntry, getSlashCommandSuggestions } from "./autocomplete/slash-commands";
import type {
    AppliedCompletion,
    AtItemProvider,
    AutocompleteItem,
    AutocompleteProvider,
    AutocompleteSuggestions,
} from "./autocomplete/types";

export type {
    AppliedCompletion,
    AtItemProvider,
    AutocompleteItem,
    AutocompleteProvider,
    AutocompleteSuggestions,
    SlashCommand,
} from "./autocomplete/types";

// Combined provider that handles both slash commands and file paths
export class CombinedAutocompleteProvider implements AutocompleteProvider {
    private commands: CommandEntry[];
    private basePath: string;
    private fdPath: string | null;
    private extraAtItems: AtItemProvider | null;

    constructor(
        commands: CommandEntry[] = [],
        basePath: string,
        fdPath: string | null = null,
        extraAtItems: AtItemProvider | null = null,
    ) {
        this.commands = commands;
        this.basePath = basePath;
        this.fdPath = fdPath;
        this.extraAtItems = extraAtItems;
    }

    async getSuggestions(
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        options: { signal: AbortSignal; force?: boolean },
    ): Promise<AutocompleteSuggestions | null> {
        const currentLine = lines[cursorLine] || "";
        const textBeforeCursor = currentLine.slice(0, cursorCol);

        const atPrefix = extractAtPrefix(textBeforeCursor);
        if (atPrefix) {
            return this.getAtSuggestions(atPrefix, options.signal);
        }

        if (!options.force && textBeforeCursor.startsWith("/")) {
            return getSlashCommandSuggestions(this.commands, textBeforeCursor);
        }

        const pathMatch = extractPathPrefix(textBeforeCursor, options.force ?? false);
        if (pathMatch === null) {
            return null;
        }

        const suggestions = getDirectorySuggestions(pathMatch, this.basePath);
        if (suggestions.length === 0) return null;
        return { items: suggestions, prefix: pathMatch };
    }

    applyCompletion(
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        item: AutocompleteItem,
        prefix: string,
    ): AppliedCompletion {
        return applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    // Check if we should trigger file completion (called on Tab key)
    shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
        const currentLine = lines[cursorLine] || "";
        const textBeforeCursor = currentLine.slice(0, cursorCol);

        // Don't trigger if we're typing a slash command at the start of the line
        if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
            return false;
        }

        return true;
    }

    private async getAtSuggestions(atPrefix: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
        const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
        // Non-file things that answer to `@` (MCP resources) come first:
        // they are a small, exact-matching set, while the file walk returns
        // up to MAX_FUZZY_SUGGESTIONS fuzzy hits that would bury them.
        const extra = (await this.extraAtItems?.(rawPrefix, signal)) ?? [];
        const suggestions = await getFuzzyFileSuggestions(rawPrefix, {
            basePath: this.basePath,
            fdPath: this.fdPath,
            isQuotedPrefix,
            signal,
        });
        const items = [...extra, ...suggestions];
        if (items.length === 0) return null;
        return { items, prefix: atPrefix };
    }
}
