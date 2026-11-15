/**
 * The composer and its completions: slash commands (with server-completed MCP
 * prompt arguments), `@` file mentions, `@mcp:` resources, and the popup that
 * shows them painted over the transcript.
 */
import {
    type AutocompleteItem,
    CombinedAutocompleteProvider,
    Editor,
    type SlashCommand as TuiSlashCommand,
} from "@notshekhar/loop-tui";
import {
    ensureTool,
    getMcpManager,
    isMcpEnabled,
    mcpPromptCommandName,
    parseMcpPromptCommand,
    promptArgumentCompletions,
    promptArgumentHint,
    isMcpMentionQuery,
    mcpMentionItems,
    type CommandRegistry,
} from "@notshekhar/loop-core";
import type { AppCore } from "./context";
import { editorTheme, type Layout } from "./layout";
import type { Viewport } from "./viewport";

export interface Composer {
    editor: Editor;
    /** Rebuild slash-command autocomplete after runtime command changes. */
    refreshCommands: () => void;
}

export function createComposer(core: AppCore): Composer {
    const editor = new Editor(core.tui, editorTheme, { paddingX: 1 });

    // @-mention fuzzy file search needs the `fd` binary; without it the provider
    // silently returns no file suggestions. Resolve it once (from PATH, else
    // download) and rebuild the provider when ready. `null` until then — slash
    // commands and explicit path completion still work in the meantime.
    let fdPath: string | null = null;
    const refreshCommands = () => {
        const slashItems = slashCommandItems(core.commands);
        editor.setAutocompleteProvider(
            new CombinedAutocompleteProvider(slashItems, core.state.cwd, fdPath, mcpMentions),
        );
    };
    refreshCommands();
    void ensureTool("fd", true).then((path) => {
        if (!path) return;
        fdPath = path;
        refreshCommands();
    });
    return { editor, refreshCommands };
}

/**
 * `@mcp:…` completes the resources connected MCP servers publish. Read
 * through the manager on every keystroke rather than snapshotted: servers
 * connect after the editor exists, and a server can announce a changed
 * resource list at any point in the session.
 */
async function mcpMentions(query: string): Promise<AutocompleteItem[]> {
    if (!isMcpEnabled() || !isMcpMentionQuery(query)) return [];
    return mcpMentionItems(query, getMcpManager().listResources());
}

function slashCommandItems(commands: CommandRegistry): TuiSlashCommand[] {
    return commands.list().map((c) => {
        // An MCP prompt's arguments are completed BY THE SERVER
        // (completion/complete), so the menu offers real values — branch
        // names, file paths, whatever that prompt's argument means — rather
        // than making the user know them. Everything else has no argument
        // completions, exactly as before.
        const prompt = parseMcpPromptCommand(c.name);
        const entry =
            prompt &&
            getMcpManager()
                .listPrompts()
                .find((p) => mcpPromptCommandName(p) === c.name);
        if (!entry) return { name: c.name, description: c.description };
        return {
            name: c.name,
            description: c.description,
            argumentHint: promptArgumentHint(entry),
            getArgumentCompletions: (argumentPrefix: string) =>
                promptArgumentCompletions(entry, argumentPrefix, (server, ref, argument) =>
                    getMcpManager().completeArgument(server, ref, argument),
                ),
        };
    });
}

/**
 * The completion list (`/`, `@`) is painted over the transcript instead of
 * being appended to the editor, for the reason every overlay here exists:
 * appended, it makes the frame taller for as long as it is open, the
 * terminal scrolls to fit it, and the rows that scrolled off cannot come
 * back when it closes — one `/` typed and deleted leaves a band behind.
 * Drawn over the frame it costs no height, so nothing scrolls either way.
 *
 * It sits directly above the editor rather than below it, which is where
 * the room is once it is no longer allowed to make any.
 *
 * Held open for the whole session and gated on `visible`: the list comes
 * and goes on nearly every keystroke, and an overlay that is registered
 * but not visible costs the frame nothing.
 */
export function mountAutocompletePopup(core: AppCore, layout: Layout, viewport: Viewport): void {
    const { tui } = core;
    const { editor, editorContainer } = layout;
    editor.setPopupHosted(true);
    tui.showOverlay(
        {
            render: (width: number) => editor.renderAutocompletePopup(width),
            invalidate: () => {},
        },
        {
            width: "100%",
            maxHeight: "100%",
            anchor: "bottom-left",
            margin: () => ({
                bottom:
                    viewport.rowsBelowFrame() +
                    viewport.rowsBelowEditor() +
                    editorContainer.render(tui.terminal.columns).length,
            }),
            visible: () => editor.isShowingAutocomplete() && viewport.promptOnScreen(),
            // The editor keeps the keys: the list is driven through it, the
            // same as when it drew the rows itself.
            nonCapturing: true,
        },
    );
}
