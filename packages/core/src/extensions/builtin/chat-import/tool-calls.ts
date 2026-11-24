/**
 * Another agent's tool calls, renamed into loop's own tools where one does the
 * same job.
 *
 * A translated call draws as the row loop would have drawn (`◆ bash ls`,
 * `Read 3 files`) and, if the conversation is continued, reads to the model
 * like its own history. A call with no loop counterpart keeps its name and
 * input untouched: describing it as something it was not would be worse than
 * an unfamiliar row.
 *
 * The table is keyed by the foreign name, lowercased. Claude Code, Codex and
 * Cursor (CLI and IDE) name their tools differently enough that one table
 * holds all of them without a collision.
 */

type Args = Record<string, unknown>;

export interface TranslatedCall {
    toolName: string;
    input: unknown;
}

/** The first of `keys` the call actually set, as a string. */
function pick(args: Args, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === "string" && value) return value;
    }
    return undefined;
}

function defined(fields: Record<string, unknown>): Args {
    return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

const PATH_KEYS = ["path", "file_path", "filePath", "target_file", "targetFile", "relativeWorkspacePath"];
const DIR_KEYS = ["path", "target_directory", "targetDirectory", "directory", "dir_path"];

/** A shell command, whichever way the source spelled it — including Codex's argv form `["bash", "-lc", cmd]`. */
function commandOf(args: Args): string | undefined {
    const text = pick(args, "command", "cmd");
    if (text) return text;
    const argv = args.command ?? args.cmd;
    if (!Array.isArray(argv)) return undefined;
    const parts = argv.map(String);
    const shellFlag = parts.findIndex((p) => p === "-c" || p === "-lc");
    return shellFlag >= 0 && parts[shellFlag + 1] ? parts[shellFlag + 1] : parts.join(" ");
}

const bash = (args: Args): TranslatedCall => ({ toolName: "bash", input: defined({ command: commandOf(args) }) });

const read = (args: Args): TranslatedCall => ({
    toolName: "read",
    input: defined({
        path: pick(args, ...PATH_KEYS),
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
    }),
});

const write = (args: Args): TranslatedCall => ({
    toolName: "write",
    input: defined({ path: pick(args, ...PATH_KEYS), content: pick(args, "content", "contents") }),
});

/** One replacement, in loop's `edits` shape. */
function replacement(edit: Args): { oldText: string; newText: string } {
    return {
        oldText: pick(edit, "old_string", "oldText", "old_str") ?? "",
        newText: pick(edit, "new_string", "newText", "new_str") ?? "",
    };
}

const edit = (args: Args): TranslatedCall => {
    const many = Array.isArray(args.edits) ? (args.edits as Args[]) : [args];
    return { toolName: "edit", input: { path: pick(args, ...PATH_KEYS), edits: many.map(replacement) } };
};

const grep = (args: Args): TranslatedCall => ({
    toolName: "grep",
    input: defined({
        pattern: pick(args, "pattern", "query", "regex"),
        path: pick(args, ...DIR_KEYS),
        glob: pick(args, "glob", "include", "glob_pattern"),
    }),
});

const find = (args: Args): TranslatedCall => ({
    toolName: "find",
    input: defined({ pattern: pick(args, "pattern", "glob_pattern", "globPattern"), path: pick(args, ...DIR_KEYS) }),
});

const ls = (args: Args): TranslatedCall => ({ toolName: "ls", input: defined({ path: pick(args, ...DIR_KEYS) }) });

/** loop reads a URL with `read`. */
const fetchUrl = (args: Args): TranslatedCall => ({ toolName: "read", input: defined({ path: pick(args, "url") }) });

const websearch = (args: Args): TranslatedCall => ({
    toolName: "websearch",
    input: defined({ query: pick(args, "query", "search_term", "searchTerm") }),
});

const task = (args: Args): TranslatedCall => ({
    toolName: "task",
    input: defined({ agent: pick(args, "subagent_type", "agent") ?? "general", prompt: pick(args, "prompt") }),
});

const TRANSLATIONS: Record<string, (args: Args) => TranslatedCall> = {
    // Claude Code
    bash,
    read,
    write,
    edit,
    multiedit: edit,
    grep,
    glob: find,
    ls,
    webfetch: fetchUrl,
    websearch,
    task,
    agent: task,
    // Codex
    exec_command: bash,
    shell: bash,
    local_shell: bash,
    // Cursor CLI
    strreplace: edit,
    search_replace: edit,
    // Cursor IDE
    run_terminal_command_v2: bash,
    run_terminal_cmd: bash,
    read_file: read,
    read_file_v2: read,
    ripgrep_raw_search: grep,
    grep_search: grep,
    glob_file_search: find,
    file_search: find,
    list_dir: ls,
    list_dir_v2: ls,
    web_fetch: fetchUrl,
    web_search: websearch,
    task_v2: task,
};

export function translateToolCall(name: string, input: unknown): TranslatedCall {
    const translate = TRANSLATIONS[name.toLowerCase()];
    if (!translate || !input || typeof input !== "object" || Array.isArray(input)) return { toolName: name, input };
    return translate(input as Args);
}

/** A tool's output as the text loop shows: strings as they are, text-part arrays joined, anything else as JSON. */
export function outputText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) {
        return value
            .map((part) => {
                if (typeof part === "string") return part;
                const p = part as { type?: string; text?: unknown };
                if (typeof p?.text === "string") return p.text;
                return p?.type === "image" ? "[image]" : JSON.stringify(part);
            })
            .join("\n");
    }
    return JSON.stringify(value, null, 2);
}

/** Parse a JSON string a source stored arguments or results in; the raw value when it is not JSON. */
export function parseJsonish(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}
