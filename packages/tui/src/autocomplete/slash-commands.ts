import { fuzzyFilter } from "../fuzzy";
import type { AutocompleteItem, AutocompleteSuggestions, SlashCommand } from "./types";

/** A command is either a full SlashCommand or a bare item whose `value` is its name. */
export type CommandEntry = SlashCommand | AutocompleteItem;

function commandName(cmd: CommandEntry): string {
    return "name" in cmd ? cmd.name : cmd.value;
}

/** "<hint> — <description>", or whichever of the two exists. */
function commandDescription(cmd: CommandEntry): string | undefined {
    const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
    const desc = cmd.description ?? "";
    const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
    return fullDesc || undefined;
}

/** `/mo` → the commands fuzzy-matching "mo". */
function getCommandNameSuggestions(commands: CommandEntry[], textBeforeCursor: string): AutocompleteSuggestions | null {
    const prefix = textBeforeCursor.slice(1);
    const commandItems = commands.map((cmd) => {
        const name = commandName(cmd);
        return { name, label: name, description: commandDescription(cmd) };
    });

    const filtered = fuzzyFilter(commandItems, prefix, (item) => item.name).map((item) => ({
        value: item.name,
        label: item.label,
        ...(item.description && { description: item.description }),
    }));

    if (filtered.length === 0) return null;
    return { items: filtered, prefix: textBeforeCursor };
}

/** `/model gp` → whatever the `model` command offers for "gp". */
async function getCommandArgumentSuggestions(
    commands: CommandEntry[],
    textBeforeCursor: string,
    spaceIndex: number,
): Promise<AutocompleteSuggestions | null> {
    const name = textBeforeCursor.slice(1, spaceIndex);
    const argumentText = textBeforeCursor.slice(spaceIndex + 1);

    const command = commands.find((cmd) => commandName(cmd) === name);
    if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
        return null;
    }

    const argumentSuggestions = await command.getArgumentCompletions(argumentText);
    if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
        return null;
    }
    return { items: argumentSuggestions, prefix: argumentText };
}

/** Suggestions for text that starts with "/": the command name until a space, then its arguments. */
export async function getSlashCommandSuggestions(
    commands: CommandEntry[],
    textBeforeCursor: string,
): Promise<AutocompleteSuggestions | null> {
    const spaceIndex = textBeforeCursor.indexOf(" ");
    if (spaceIndex === -1) {
        return getCommandNameSuggestions(commands, textBeforeCursor);
    }
    return getCommandArgumentSuggestions(commands, textBeforeCursor, spaceIndex);
}
