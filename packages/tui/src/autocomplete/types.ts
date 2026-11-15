export interface AutocompleteItem {
    value: string;
    label: string;
    description?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
    name: string;
    description?: string;
    argumentHint?: string;
    // Function to get argument completions for this command
    // Returns null if no argument completion is available
    getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

export interface AutocompleteSuggestions {
    items: AutocompleteItem[];
    prefix: string; // What we're matching against (e.g., "/" or "src/")
}

/** The new text and cursor after a completion is applied. */
export interface AppliedCompletion {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
}

/**
 * Extra `@` completions that aren't files — MCP resources, today.
 *
 * A callback rather than a list: the set changes while the session runs (a
 * server connects, a server announces a changed resource list), and a snapshot
 * taken when the provider was built would go stale the first time either
 * happens. Returns items whose `value` includes the leading `@`, exactly like
 * the file suggestions it is merged with.
 */
export type AtItemProvider = (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>;

export interface AutocompleteProvider {
    /** Characters that should naturally trigger this provider at token boundaries. */
    triggerCharacters?: string[];

    // Get autocomplete suggestions for current text/cursor position
    // Returns null if no suggestions available
    getSuggestions(
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        options: { signal: AbortSignal; force?: boolean },
    ): Promise<AutocompleteSuggestions | null>;

    // Apply the selected item
    // Returns the new text and cursor position
    applyCompletion(
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        item: AutocompleteItem,
        prefix: string,
    ): AppliedCompletion;

    // Check if file completion should trigger for explicit Tab completion
    shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}
