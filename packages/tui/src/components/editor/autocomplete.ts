import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "../../autocomplete";
import { isWhitespaceChar } from "../../utils";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "../select-list";
import type { EditorState } from "./types";

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
    minPrimaryColumnWidth: 12,
    maxPrimaryColumnWidth: 32,
};

/** A short pause before querying for @-attachments, so a fast typist doesn't fire one request per key. */
const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];
const DEFAULT_MAX_VISIBLE = 5;

type RequestOptions = { force: boolean; explicitTab: boolean };
type ListState = "regular" | "force";

/** What the autocomplete controller needs from the editor it serves. */
export interface AutocompleteHost {
    readonly state: EditorState;
    getText(): string;
    /** Apply a chosen completion to the text (undoable). */
    applyCompletion(item: AutocompleteItem, prefix: string): void;
    notifyChange(): void;
    requestRender(): void;
}

/** Clamp a requested list height to 3..20 rows. */
export function clampMaxVisible(maxVisible: number): number {
    return Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : DEFAULT_MAX_VISIBLE;
}

// Slash menu only allowed on the first line of the editor
export function isInSlashCommandContext(state: EditorState, textBeforeCursor: string): boolean {
    return state.cursorLine === 0 && textBeforeCursor.trimStart().startsWith("/");
}

/** Is the cursor where a "/" would start a command (first line, nothing but "/" before it)? */
export function isAtStartOfMessage(state: EditorState, textBeforeCursor: string): boolean {
    if (state.cursorLine !== 0) return false;
    const trimmed = textBeforeCursor.trim();
    return trimmed === "" || trimmed === "/";
}

function escapeCharacterClass(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

function buildTriggerPattern(triggerCharacters: string[]): RegExp {
    return new RegExp(`(?:^|[\\s])[${triggerCharacters.map(escapeCharacterClass).join("")}][^\\s]*$`);
}

function buildDebouncePattern(triggerCharacters: string[]): RegExp {
    const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
    return new RegExp(`(?:^|[ \\t])(?:@(?:"[^"]*|[^\\s]*)|[${escapedWithoutAt.join("")}][^\\s]*)$`);
}

/**
 * Find the best autocomplete item index for the given prefix.
 * Returns -1 if no match is found.
 *
 * Match priority:
 * 1. Exact match (prefix === item.value) -> always selected
 * 2. Prefix match -> first item whose value starts with prefix
 * 3. No match -> -1 (keep default highlight)
 *
 * Matching is case-sensitive and checks item.value only.
 */
function bestMatchIndex(items: ReadonlyArray<{ value: string }>, prefix: string): number {
    if (!prefix) return -1;
    let firstPrefixIndex = -1;
    for (let i = 0; i < items.length; i++) {
        const value = items[i]!.value;
        if (value === prefix) return i;
        if (firstPrefixIndex === -1 && value.startsWith(prefix)) firstPrefixIndex = i;
    }
    return firstPrefixIndex;
}

/**
 * The editor's completion list: when to ask the provider, debouncing and
 * cancelling requests, ignoring answers that arrive for stale text, and the
 * list that shows the results.
 */
export class EditorAutocomplete {
    private provider?: AutocompleteProvider;
    private triggerCharacters = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
    private triggerPattern = buildTriggerPattern(this.triggerCharacters);
    private debouncePattern = buildDebouncePattern(this.triggerCharacters);
    private list?: SelectList;
    private listState: ListState | null = null;
    private listPrefix = "";
    private abort?: AbortController;
    private debounceTimer?: ReturnType<typeof setTimeout>;
    private requestTask: Promise<void> = Promise.resolve();
    private startToken = 0;
    private requestId = 0;

    constructor(
        private readonly host: AutocompleteHost,
        private readonly theme: SelectListTheme,
        public maxVisible: number,
    ) {}

    get currentProvider(): AutocompleteProvider | undefined {
        return this.provider;
    }

    /** The list on screen, if one is up. */
    get openList(): SelectList | undefined {
        return this.listState ? this.list : undefined;
    }

    get prefix(): string {
        return this.listPrefix;
    }

    isShowing(): boolean {
        return this.listState !== null;
    }

    setProvider(provider: AutocompleteProvider): void {
        this.cancel();
        this.provider = provider;
        this.setTriggerCharacters(provider.triggerCharacters ?? []);
    }

    /** Close the list and drop any request in flight. */
    cancel(): void {
        this.cancelRequest();
        this.listState = null;
        this.list = undefined;
        this.listPrefix = "";
    }

    /** Re-query an open list after the text or cursor changed. */
    update(): void {
        if (!this.listState || !this.provider) return;
        this.request({ force: this.listState === "force", explicitTab: false });
    }

    /** After typing `char`, open the list if it starts or continues a completion. */
    onCharacterTyped(char: string, textBeforeCursor: string): void {
        if (this.listState) {
            this.update();
            return;
        }
        const state = this.host.state;
        if (char === "/" && isAtStartOfMessage(state, textBeforeCursor)) {
            this.tryTrigger();
        } else if (this.triggerCharacters.includes(char)) {
            // Only at a token boundary: start of text, or after a space or tab.
            const charBeforeSymbol = textBeforeCursor[textBeforeCursor.length - 2];
            if (textBeforeCursor.length === 1 || charBeforeSymbol === " " || charBeforeSymbol === "\t") {
                this.tryTrigger();
            }
        } else if (/[a-zA-Z0-9.\-_]/.test(char)) {
            this.retriggerInContext(textBeforeCursor);
        }
    }

    /** After a deletion: refresh an open list, or reopen one if the cursor is back in a completable spot. */
    onTextDeleted(textBeforeCursor: string): void {
        if (this.listState) this.update();
        else this.retriggerInContext(textBeforeCursor);
    }

    /** Tab with no list open: complete a command name, or force file completion. */
    handleTab(textBeforeCursor: string): void {
        if (!this.provider) return;
        if (isInSlashCommandContext(this.host.state, textBeforeCursor) && !textBeforeCursor.trimStart().includes(" ")) {
            this.request({ force: false, explicitTab: true });
        } else {
            this.request({ force: true, explicitTab: true });
        }
    }

    private retriggerInContext(textBeforeCursor: string): void {
        if (isInSlashCommandContext(this.host.state, textBeforeCursor) || this.triggerPattern.test(textBeforeCursor)) {
            this.tryTrigger();
        }
    }

    private tryTrigger(): void {
        this.request({ force: false, explicitTab: false });
    }

    private setTriggerCharacters(triggerCharacters: string[]): void {
        const next = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
        for (const character of triggerCharacters) {
            if (
                character.length !== 1 ||
                character === "/" ||
                isWhitespaceChar(character) ||
                next.includes(character)
            ) {
                continue;
            }
            next.push(character);
        }
        this.triggerCharacters = next;
        this.triggerPattern = buildTriggerPattern(next);
        this.debouncePattern = buildDebouncePattern(next);
    }

    private request(options: RequestOptions): void {
        if (!this.provider) return;
        if (options.force && !this.fileCompletionApplies()) return;

        this.cancelRequest();
        const startToken = ++this.startToken;
        const debounceMs = this.debounceMs(options);
        if (debounceMs > 0) {
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = undefined;
                void this.startRequest(startToken, options);
            }, debounceMs);
            return;
        }
        void this.startRequest(startToken, options);
    }

    private fileCompletionApplies(): boolean {
        const { lines, cursorLine, cursorCol } = this.host.state;
        return this.provider?.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    }

    private debounceMs(options: RequestOptions): number {
        if (options.explicitTab || options.force) return 0;
        const { lines, cursorLine, cursorCol } = this.host.state;
        const textBeforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
        return this.debouncePattern.test(textBeforeCursor) ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
    }

    /** Requests run one after another, so an older answer can never land after a newer one. */
    private async startRequest(startToken: number, options: RequestOptions): Promise<void> {
        const previousTask = this.requestTask;
        this.requestTask = (async () => {
            await previousTask;
            if (startToken !== this.startToken || !this.provider) return;
            const controller = new AbortController();
            this.abort = controller;
            await this.runRequest(++this.requestId, controller, options);
        })();
        await this.requestTask;
    }

    private async runRequest(requestId: number, controller: AbortController, options: RequestOptions): Promise<void> {
        const provider = this.provider;
        if (!provider) return;
        const snapshot = {
            text: this.host.getText(),
            line: this.host.state.cursorLine,
            col: this.host.state.cursorCol,
        };
        const { lines, cursorLine, cursorCol } = this.host.state;
        const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, {
            signal: controller.signal,
            force: options.force,
        });
        if (!this.isCurrent(requestId, controller, snapshot)) return;
        this.abort = undefined;
        this.showSuggestions(suggestions, options);
        this.host.requestRender();
    }

    private isCurrent(
        requestId: number,
        controller: AbortController,
        snapshot: { text: string; line: number; col: number },
    ): boolean {
        const { cursorLine, cursorCol } = this.host.state;
        return (
            !controller.signal.aborted &&
            requestId === this.requestId &&
            this.host.getText() === snapshot.text &&
            cursorLine === snapshot.line &&
            cursorCol === snapshot.col
        );
    }

    private showSuggestions(suggestions: AutocompleteSuggestions | null, options: RequestOptions): void {
        if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
            this.cancel();
            return;
        }
        // An explicit Tab with exactly one file match completes it straight away.
        if (options.force && options.explicitTab && suggestions.items.length === 1) {
            this.host.applyCompletion(suggestions.items[0]!, suggestions.prefix);
            this.host.notifyChange();
            return;
        }
        this.openWith(suggestions, options.force ? "force" : "regular");
    }

    private openWith(suggestions: AutocompleteSuggestions, state: ListState): void {
        this.listPrefix = suggestions.prefix;
        const layout = suggestions.prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
        this.list = new SelectList(suggestions.items, this.maxVisible, this.theme, layout);
        const best = bestMatchIndex(suggestions.items, suggestions.prefix);
        if (best >= 0) this.list.setSelectedIndex(best);
        this.listState = state;
    }

    private cancelRequest(): void {
        this.startToken += 1;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        this.abort?.abort();
        this.abort = undefined;
    }
}
