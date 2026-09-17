/**
 * MCP prompts as slash commands: `/mcp:<server>:<prompt>`.
 *
 * A prompt is a server-authored message template with named arguments — the
 * protocol's answer to "the user, not the model, decides to start this". The
 * natural home for that in loop is the slash-command list, next to the
 * commands and recipes people already reach for, so they are registered as
 * real commands rather than hidden behind a panel.
 *
 * Registration is dynamic, and re-runs whenever a server connects, drops, or
 * announces `prompts/list_changed`: a command list that only reflects the
 * servers that happened to be up at launch is a command list people learn not
 * to trust.
 */
import type { CommandContext, CommandRegistry, SlashCommand } from "../commands";
import type { McpPromptArgument, McpPromptEntry } from "./features";

export const MCP_PROMPT_COMMAND_PREFIX = "mcp:";

export function mcpPromptCommandName(entry: Pick<McpPromptEntry, "server" | "name">): string {
    return `${MCP_PROMPT_COMMAND_PREFIX}${entry.server}:${entry.name}`;
}

/** The inverse, for a name that came back from the registry or the composer. */
export function parseMcpPromptCommand(name: string): { server: string; prompt: string } | undefined {
    if (!name.startsWith(MCP_PROMPT_COMMAND_PREFIX)) return undefined;
    const body = name.slice(MCP_PROMPT_COMMAND_PREFIX.length);
    const colon = body.indexOf(":");
    if (colon <= 0 || colon === body.length - 1) return undefined;
    return { server: body.slice(0, colon), prompt: body.slice(colon + 1) };
}

/**
 * Split a command's arguments, honouring quotes.
 *
 * Prompt arguments are prose as often as they are identifiers ("summarize this
 * in the style of a changelog"), and a splitter that only knows whitespace
 * turns one argument into six.
 */
export function splitArgs(raw: string): string[] {
    const out: string[] = [];
    let current = "";
    let quote: '"' | "'" | undefined;
    let has = false;
    for (const char of raw.trim()) {
        if (quote) {
            if (char === quote) quote = undefined;
            else current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            has = true;
            continue;
        }
        if (/\s/.test(char)) {
            if (current || has) out.push(current);
            current = "";
            has = false;
            continue;
        }
        current += char;
    }
    if (current || has) out.push(current);
    return out;
}

export interface ParsedPromptArgs {
    values: Record<string, string>;
    /** Declared, required, and not supplied — the only reason to refuse to run. */
    missing: string[];
    /** `key=value` for a key the prompt never declared; reported, not silently dropped. */
    unknown: string[];
}

/**
 * Map command-line arguments onto a prompt's declared arguments.
 *
 * Both forms work, because both get typed: `key=value` in any order, and bare
 * positional values that fill the declared arguments in order. A positional
 * never overwrites a key that was given explicitly — mixing the two is exactly
 * when a silent overwrite would be hardest to spot.
 *
 * `=` inside a value is left alone (`filter=a=b` is one pair): only the first
 * `=` separates, and a token whose head isn't a declared name is positional,
 * so a sentence containing an equals sign stays a sentence.
 */
export function parsePromptArgs(raw: string, declared: McpPromptArgument[]): ParsedPromptArgs {
    const names = new Set(declared.map((a) => a.name));
    const values: Record<string, string> = {};
    const unknown: string[] = [];
    const positionals: string[] = [];

    for (const token of splitArgs(raw)) {
        const eq = token.indexOf("=");
        const head = eq > 0 ? token.slice(0, eq) : "";
        if (eq > 0 && names.has(head)) {
            values[head] = token.slice(eq + 1);
        } else if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(head) && declared.length > 0) {
            // Looks like a key=value for a key this prompt doesn't have. Saying
            // so beats silently feeding "tone=blunt" in as a positional.
            unknown.push(head);
        } else {
            positionals.push(token);
        }
    }

    for (const arg of declared) {
        if (arg.name in values) continue;
        const next = positionals.shift();
        if (next !== undefined) values[arg.name] = next;
    }
    // Anything left over joins the last declared argument rather than being
    // dropped: an unquoted sentence is the common case, and losing its tail is
    // worse than a slightly long argument.
    if (positionals.length > 0 && declared.length > 0) {
        const last = declared[declared.length - 1].name;
        values[last] = [values[last], ...positionals].filter(Boolean).join(" ");
    }

    const missing = declared.filter((a) => a.required && !values[a.name]?.trim()).map((a) => a.name);
    return { values, missing, unknown };
}

/** `<path> [tone]` — the usage hint shown beside the command. */
export function promptArgumentHint(entry: McpPromptEntry): string {
    return entry.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

function usage(entry: McpPromptEntry, problem: string): string {
    const hint = promptArgumentHint(entry);
    const lines = [
        `${problem}`,
        `Usage: /${mcpPromptCommandName(entry)}${hint ? ` ${hint}` : ""}`,
        ...entry.arguments.map(
            (a) => `  ${a.name}${a.required ? " (required)" : ""}${a.description ? ` — ${a.description}` : ""}`,
        ),
    ];
    return lines.join("\n");
}

export interface McpPromptCommandDeps {
    /** Fetch the prompt's messages, already rendered to a single block. */
    getPrompt: (server: string, prompt: string, args: Record<string, string>) => Promise<string>;
}

/** One slash command for one server-side prompt. */
export function mcpPromptCommand(entry: McpPromptEntry, deps: McpPromptCommandDeps): SlashCommand {
    const hint = promptArgumentHint(entry);
    return {
        name: mcpPromptCommandName(entry),
        description:
            [entry.description ?? entry.title ?? `${entry.name} prompt`, hint ? `(${hint})` : ""]
                .filter(Boolean)
                .join(" ") + ` — from MCP server "${entry.server}"`,
        handler: async (ctx: CommandContext, rawArgs: string) => {
            const parsed = parsePromptArgs(rawArgs, entry.arguments);
            if (parsed.unknown.length > 0) {
                ctx.emit("error", usage(entry, `Unknown argument${parsed.unknown.length > 1 ? "s" : ""}: ${parsed.unknown.join(", ")}`));
                return;
            }
            if (parsed.missing.length > 0) {
                ctx.emit("error", usage(entry, `Missing required argument${parsed.missing.length > 1 ? "s" : ""}: ${parsed.missing.join(", ")}`));
                return;
            }
            let text: string;
            try {
                text = await deps.getPrompt(entry.server, entry.name, parsed.values);
            } catch (err) {
                ctx.emit("error", `MCP prompt "${entry.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
            if (!text.trim()) {
                ctx.emit("error", `MCP prompt "${entry.name}" returned nothing to send.`);
                return;
            }
            // Same path as /init: submitted as if the user had typed it, so the
            // turn owns permissions, tools, persistence and cancellation.
            ctx.emit("run-prompt", text);
        },
    };
}

/**
 * Make the registry's `mcp:` commands match the given prompts exactly.
 *
 * Stale commands are unregistered, not left behind: a server that goes away
 * must take its commands with it, or the list fills with prompts that can only
 * fail. Returns true when anything changed, so the caller can refresh the
 * completion menu only when it needs to.
 */
export function syncMcpPromptCommands(
    reg: CommandRegistry,
    prompts: McpPromptEntry[],
    deps: McpPromptCommandDeps,
): boolean {
    const wanted = new Map(prompts.map((entry) => [mcpPromptCommandName(entry), entry]));
    let changed = false;

    for (const command of reg.list()) {
        if (!command.name.startsWith(MCP_PROMPT_COMMAND_PREFIX)) continue;
        if (wanted.has(command.name)) continue;
        reg.unregister(command.name);
        changed = true;
    }
    for (const [name, entry] of wanted) {
        // Re-register unconditionally: a prompt can change its description or
        // arguments without changing its name, and the old closure would go on
        // validating against arguments the server no longer has.
        if (!reg.has(name)) changed = true;
        reg.register(mcpPromptCommand(entry, deps));
    }
    return changed;
}

/** Where the caret is in a half-typed argument list. */
export interface PromptCompletionTarget {
    /** Declared argument the caret is filling. */
    argument: string;
    /** What has been typed of its value so far — sent to the server as context. */
    partial: string;
    /** Text before the token being typed; a completion is appended to this. */
    head: string;
    /** True when the token is written as `name=value` rather than positionally. */
    keyed: boolean;
}

/**
 * Which argument is being typed right now.
 *
 * Completion has to answer "of what?" before it can ask the server anything:
 * `completion/complete` takes an argument NAME, not a cursor offset. The head
 * is kept verbatim because the TUI replaces the whole argument string with the
 * chosen item — a completion that returns only the last token silently eats
 * every argument typed before it.
 */
export function promptCompletionTarget(
    raw: string,
    declared: McpPromptArgument[],
): PromptCompletionTarget | undefined {
    if (declared.length === 0) return undefined;
    const atBoundary = raw === "" || /\s$/.test(raw);
    const lastSpace = raw.lastIndexOf(" ");
    const head = atBoundary ? raw : raw.slice(0, lastSpace + 1);
    const token = atBoundary ? "" : raw.slice(lastSpace + 1);

    const eq = token.indexOf("=");
    if (eq > 0) {
        const name = token.slice(0, eq);
        if (!declared.some((a) => a.name === name)) return undefined;
        return { argument: name, partial: token.slice(eq + 1), head, keyed: true };
    }

    // Positional: the first declared argument nothing has filled yet.
    const filled = parsePromptArgs(head, declared).values;
    const next = declared.find((a) => !filled[a.name]?.trim());
    if (!next) return undefined;
    return { argument: next.name, partial: token, head, keyed: false };
}

export interface PromptCompletionItem {
    /** The full argument string to replace what was typed. */
    value: string;
    /** Just the completed value, for display. */
    label: string;
}

/** A value that has to survive re-splitting gets quoted on the way in. */
function quoteIfNeeded(value: string): string {
    if (!/[\s"']/.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Ask the server to complete the argument under the caret.
 *
 * Returns [] for anything it can't answer — a prompt with no arguments, a
 * server that never declared `completions`, a failed request. A completion menu
 * that throws is worse than one that stays closed.
 */
export async function promptArgumentCompletions(
    entry: McpPromptEntry,
    raw: string,
    complete: (
        server: string,
        ref: { type: "ref/prompt"; name: string },
        argument: { name: string; value: string },
    ) => Promise<string[]>,
): Promise<PromptCompletionItem[]> {
    const target = promptCompletionTarget(raw, entry.arguments);
    if (!target) return [];
    const values = await complete(
        entry.server,
        { type: "ref/prompt", name: entry.name },
        { name: target.argument, value: target.partial },
    );
    return values.map((value) => ({
        value: `${target.head}${target.keyed ? `${target.argument}=` : ""}${quoteIfNeeded(value)}`,
        label: value,
    }));
}
