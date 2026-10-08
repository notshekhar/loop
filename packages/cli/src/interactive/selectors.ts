import {
    Container,
    Editor,
    type EditorTheme,
    fuzzyFilter,
    SelectList,
    type SelectItem,
    Text,
    TUI,
} from "@notshekhar/loop-tui";
import { DynamicBorder } from "./ui/messages";
import { getSelectListTheme } from "./ui/theme";
import { isEsc } from "./keys";
import { accent, accentTitle, dim, strong } from "./ui/text";

export function buildSelectorWrapper(items: SelectItem[], title: string | undefined, list: SelectList): Container {
    const wrapper = new Container();
    if (title) wrapper.addChild(new Text(accentTitle(` ${title}`), 0, 0));
    wrapper.addChild(new DynamicBorder());
    wrapper.addChild(list);
    wrapper.addChild(new DynamicBorder());
    wrapper.addChild(new Text(dim(" ↑↓ navigate · Enter select · Esc cancel"), 0, 0));
    return wrapper;
}

export interface SelectorHost {
    tui: TUI;
    /** `label` marks an agent-driven wait ("question", "bash approval") and
     * names it for agent-state watchers, which show the pane as blocked while
     * the prompt is open. Menus the user opened themselves must leave it
     * unset — they are not the agent waiting on input. */
    showSelector: (component: Container, focusable: Container | SelectList, label?: string) => () => void;
}

type TuiWithInput = TUI & {
    addInputListener?: (cb: (d: string) => { consume: boolean } | undefined) => () => void;
};

/**
 * Search the list the way the thing you are looking for is actually spelled.
 *
 * A plain substring test cannot find a model. Ids carry their own punctuation —
 * `custom:pronto-gpt/openai/gpt-5.6-sol` — so "gpt5sol" matches nothing, and
 * typing the two words you remember, "openai sol", matches nothing either
 * because a space appears nowhere in the id. Both read as the search being
 * broken rather than the query being wrong.
 *
 * The editor's completion menu has always used fuzzy matching for exactly this
 * (`fuzzyFilter`): tokens split on whitespace and slashes, every token has to
 * match somewhere as a subsequence, and results come back ranked — word-boundary
 * and consecutive hits first, so `sol` puts `gpt-5.6-sol` above something that
 * merely contains those letters. The pickers use it now too.
 *
 * Descriptions stay on a substring test and come after the ranked matches.
 * Fuzzy over a long sentence matches nearly everything, which would bury the
 * ranking under noise in menus like /settings where descriptions are prose.
 */
function filterItems(items: SelectItem[], query: string): SelectItem[] {
    if (!query.trim()) return items;
    const ranked = fuzzyFilter(items, query, (item) => `${item.label} ${item.value}`);
    const seen = new Set(ranked);
    const q = query.toLowerCase();
    const byDescription = items.filter((item) => !seen.has(item) && (item.description ?? "").toLowerCase().includes(q));
    return [...ranked, ...byDescription];
}

/**
 * Like selectOnce, but with a live type-to-filter search box above the list.
 * Printable keys build the query (fuzzy across value/label, substring across
 * description), arrows navigate the filtered set, Enter selects, Esc cancels.
 * For long lists (e.g. an OpenRouter model picker).
 */
/**
 * The next page of a long list, for infinite scroll: more rows, or an empty
 * array once there are none. Called as the cursor nears the end, and while a
 * search has too few matches to fill the list.
 */
export type LoadMoreItems = () => Promise<SelectItem[]>;

export function searchSelectOnce(
    host: SelectorHost,
    initialItems: SelectItem[],
    title?: string,
    opts?: { initialIndex?: number; loadMore?: LoadMoreItems },
): Promise<SelectItem | null> {
    const items = [...initialItems];
    return new Promise((resolve) => {
        if (!items.length) {
            resolve(null);
            return;
        }
        // Sized for the page it may grow to, not the first one: the list
        // keeps its height while more rows arrive.
        const visibleRows = opts?.loadMore ? 10 : Math.min(items.length, 10);
        const list = new SelectList(items, visibleRows, getSelectListTheme());
        // Re-open at a caller-supplied position so a looping menu (e.g. /settings
        // toggles) doesn't snap back to the top after each action.
        if (opts?.initialIndex != null) list.setSelectedIndex(opts.initialIndex);
        const header = new Text("", 0, 0);
        let loading = false;
        let exhausted = !opts?.loadMore;
        const renderHeader = (query: string) =>
            header.setText(
                accentTitle(` ${title ?? "Select"}`) +
                    dim("  search: ") +
                    (query ? strong(query) : dim("(type to filter)")) +
                    (loading ? dim("  · loading more…") : ""),
            );
        renderHeader("");

        const wrapper = new Container();
        wrapper.addChild(header);
        wrapper.addChild(new DynamicBorder());
        wrapper.addChild(list);
        wrapper.addChild(new DynamicBorder());
        wrapper.addChild(new Text(dim(" type to filter · ↑↓ navigate · Enter select · Esc cancel"), 0, 0));
        const close = host.showSelector(wrapper, list);

        let done = false;
        let removeInput: (() => void) | undefined;
        const finish = (v: SelectItem | null) => {
            if (done) return;
            done = true;
            removeInput?.();
            close();
            resolve(v);
        };
        list.onSelect = (item) => finish(item);
        list.onCancel = () => finish(null);

        let query = "";
        let shown = items;
        let cursor = opts?.initialIndex ?? 0;
        const applyQuery = () => {
            shown = filterItems(items, query);
            list.setItems(shown);
            cursor = 0;
            renderHeader(query);
            host.tui.requestRender();
            fill();
        };

        // Infinite scroll: a page at a time, never two at once, until the
        // source says there is no more.
        const loadPage = async (): Promise<void> => {
            if (loading || exhausted || done || !opts?.loadMore) return;
            loading = true;
            renderHeader(query);
            host.tui.requestRender();
            let page: SelectItem[] = [];
            try {
                page = await opts.loadMore();
            } catch {
                page = [];
            }
            loading = false;
            if (page.length === 0) exhausted = true;
            if (done) return;
            items.push(...page);
            // Keep the cursor where it was: the new rows land below it.
            const keep = shown[cursor];
            shown = filterItems(items, query);
            list.setItems(shown);
            const at = keep ? shown.indexOf(keep) : -1;
            cursor = at >= 0 ? at : 0;
            list.setSelectedIndex(cursor);
            renderHeader(query);
            host.tui.requestRender();
            fill();
        };
        /** Load until the cursor has room below it, or a search has a screenful. */
        const fill = (): void => {
            if (exhausted || loading) return;
            if (shown.length - cursor <= 3 || (query && shown.length < visibleRows)) void loadPage();
        };
        list.onSelectionChange = (item) => {
            const at = shown.indexOf(item);
            if (at >= 0) cursor = at;
            fill();
        };
        fill();

        // Printable chars + backspace drive the query; everything else
        // (arrows, Enter, Esc) falls through to the focused list.
        const onInput = (data: string): { consume: boolean } | undefined => {
            if (data === "\x7f" || data === "\b") {
                if (!query) return undefined;
                query = query.slice(0, -1);
                applyQuery();
                return { consume: true };
            }
            if (data.length === 1 && data >= " " && data !== "\x7f") {
                query += data;
                applyQuery();
                return { consume: true };
            }
            return undefined;
        };
        const addInput = (host.tui as TuiWithInput).addInputListener;
        if (typeof addInput === "function") removeInput = addInput.call(host.tui, onInput);
    });
}

export function selectOnce(
    host: SelectorHost,
    items: SelectItem[],
    title?: string,
    opts?: { initialIndex?: number },
): Promise<SelectItem | null> {
    return new Promise((resolve) => {
        if (!items.length) {
            resolve(null);
            return;
        }
        const visible = Math.min(items.length, 10);
        const list = new SelectList(items, visible, getSelectListTheme());
        if (opts?.initialIndex != null) list.setSelectedIndex(opts.initialIndex);
        const wrapper = buildSelectorWrapper(items, title, list);
        const close = host.showSelector(wrapper, list);
        let done = false;
        const finish = (v: SelectItem | null) => {
            if (done) return;
            done = true;
            close();
            resolve(v);
        };
        list.onSelect = (item) => finish(item);
        list.onCancel = () => finish(null);
    });
}

/**
 * Multi-select with toggle semantics and a live type-to-filter: Enter or
 * Space flips the highlighted entry in place (cursor stays put on plain
 * toggles), printable keys filter the list (Space stays a toggle — values
 * never contain spaces), "done" confirms, Esc cancels (null).
 */
export function toggleSelectOnce(
    host: SelectorHost,
    values: string[],
    initial: Set<string>,
    title?: string,
): Promise<string[] | null> {
    return new Promise((resolve) => {
        if (!values.length) {
            resolve(null);
            return;
        }
        const selected = new Set(initial);
        const DONE = "__done__";
        const doneItem = (): SelectItem => ({
            value: DONE,
            label: `done (${selected.size}/${values.length})`,
            description:
                selected.size === values.length ? "all" : [...selected].join(", ") || "none — pick at least one",
        });
        // Stable per-value items: toggling mutates labels in place so the
        // SelectList keeps its cursor; filtering swaps the visible subset.
        const valueItems: SelectItem[] = values.map((v) => ({
            value: v,
            label: `${selected.has(v) ? "[x]" : "[ ]"} ${v}`,
            description: "",
        }));
        const items: SelectItem[] = [doneItem(), ...valueItems];
        const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());

        const header = new Text("", 0, 0);
        const renderHeader = (query: string) =>
            header.setText(
                accentTitle(` ${title ?? "Toggle"}`) +
                    dim("  search: ") +
                    (query ? strong(query) : dim("(type to filter)")),
            );
        renderHeader("");

        const wrapper = new Container();
        wrapper.addChild(header);
        wrapper.addChild(new DynamicBorder());
        wrapper.addChild(list);
        wrapper.addChild(new DynamicBorder());
        wrapper.addChild(
            new Text(dim(" type to filter · ↑↓ navigate · Enter toggles · done confirms · Esc cancel"), 0, 0),
        );
        const close = host.showSelector(wrapper, list);

        let done = false;
        const finish = (v: string[] | null) => {
            if (done) return;
            done = true;
            try {
                removeInputListener?.();
            } catch {}
            close();
            resolve(v);
        };

        const toggle = (item: SelectItem) => {
            if (item.value === DONE) return;
            if (selected.has(item.value)) selected.delete(item.value);
            else selected.add(item.value);
            // Mutate labels in place — the list keeps its cursor position.
            item.label = `${selected.has(item.value) ? "[x]" : "[ ]"} ${item.value}`;
            Object.assign(items[0], doneItem());
            host.tui.requestRender();
        };

        list.onSelect = (item) => {
            if (item.value === DONE) {
                if (selected.size === 0) return; // need at least one — keep open
                finish(values.filter((v) => selected.has(v)));
                return;
            }
            toggle(item);
        };
        list.onCancel = () => finish(null);

        let query = "";
        const applyQuery = () => {
            const visible = query.trim() ? fuzzyFilter(valueItems, query, (i) => i.value) : valueItems;
            list.setItems([items[0], ...visible]);
            renderHeader(query);
            host.tui.requestRender();
        };

        // Every printable character builds the query, space included; Enter
        // toggles the highlighted entry.
        //
        // Space used to be the toggle key, which meant it could never reach the
        // query — and with a fuzzy filter the space is how you separate the two
        // words you actually remember ("openai sol"). A list you cannot type a
        // space into reads as a search that is broken. Enter was always a
        // toggle as well, so nothing is lost by letting it be the only one.
        const onInput = (data: string): { consume: boolean } | undefined => {
            if (data === "\x7f" || data === "\b") {
                if (!query) return undefined;
                query = query.slice(0, -1);
                applyQuery();
                return { consume: true };
            }
            if (data.length === 1 && data >= " " && data !== "\x7f") {
                query += data;
                applyQuery();
                return { consume: true };
            }
            return undefined;
        };
        let removeInputListener: (() => void) | undefined;
        const addInput = (
            host.tui as unknown as {
                addInputListener?: (cb: (d: string) => { consume: boolean } | undefined) => () => void;
            }
        ).addInputListener;
        if (typeof addInput === "function") {
            removeInputListener = addInput.call(host.tui, onInput);
        }
    });
}

export function promptOnce(
    host: SelectorHost,
    editorTheme: EditorTheme,
    label?: string,
    initial?: string,
): Promise<string> {
    return new Promise((resolve) => {
        const tempEditor = new Editor(host.tui, editorTheme, { paddingX: 1 });
        if (initial) tempEditor.setText(initial);
        const wrapper = new Container();
        if (label) wrapper.addChild(new Text(accent(` ${label}`), 0, 0));
        wrapper.addChild(new DynamicBorder());
        wrapper.addChild(tempEditor);
        wrapper.addChild(new DynamicBorder());
        wrapper.addChild(new Text(dim(" Enter to submit · Shift+Enter newline · Esc to cancel"), 0, 0));
        const close = host.showSelector(wrapper, tempEditor as never);

        let done = false;
        const finish = (v: string) => {
            if (done) return;
            done = true;
            try {
                removeEscListener?.();
            } catch {}
            close();
            resolve(v);
        };

        // Editor doesn't expose its own onCancel; intercept Esc at the TUI level
        // while this prompt is showing. Listeners are LIFO so this fires before
        // the editor sees the key.
        const escListener = (data: string) => {
            if (isEsc(data)) {
                finish("");
                return { consume: true };
            }
            return undefined;
        };
        let removeEscListener: (() => void) | undefined;
        const addInput = (
            host.tui as unknown as {
                addInputListener?: (cb: (d: string) => { consume: boolean } | undefined) => () => void;
            }
        ).addInputListener;
        if (typeof addInput === "function") {
            removeEscListener = addInput.call(host.tui, escListener);
        }

        tempEditor.onSubmit = (text) => finish(text.trim());
    });
}
