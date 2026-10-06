/**
 * Native agents name their tools their own way (Claude's `Read`, Cursor's
 * `readToolCall`). Every loop surface — the TUI's verb groups, the web and
 * desktop transcript, tool summaries, edit diffs — is keyed on loop's own
 * tool vocabulary, so each native call is reported under the loop tool that
 * does the same job, with its input reshaped to that tool's schema. A tool
 * with no loop equivalent keeps its own name (MCP tools keep the
 * `server__tool` shape every surface already recognizes).
 */
export interface MappedTool {
    name: string;
    input: unknown;
}

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function defined(obj: Rec): Rec {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function mapClaudeTool(name: string, rawInput: unknown): MappedTool {
    const i = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Rec;
    switch (name) {
        case "Read":
            return { name: "read", input: defined({ path: str(i.file_path), offset: num(i.offset), limit: num(i.limit) }) };
        case "Bash":
            return { name: "bash", input: defined({ command: str(i.command), description: str(i.description) }) };
        case "Edit":
            return {
                name: "edit",
                input: { path: str(i.file_path), edits: [{ oldText: str(i.old_string) ?? "", newText: str(i.new_string) ?? "" }] },
            };
        case "MultiEdit":
            return {
                name: "edit",
                input: {
                    path: str(i.file_path),
                    edits: (Array.isArray(i.edits) ? (i.edits as Rec[]) : []).map((e) => ({
                        oldText: str(e.old_string) ?? "",
                        newText: str(e.new_string) ?? "",
                    })),
                },
            };
        case "Write":
            return { name: "write", input: { path: str(i.file_path), content: str(i.content) ?? "" } };
        case "Grep":
            return {
                name: "grep",
                input: defined({ pattern: str(i.pattern), path: str(i.path), glob: str(i.glob), ignoreCase: i["-i"] === true || undefined }),
            };
        case "Glob":
            return { name: "find", input: defined({ pattern: str(i.pattern), path: str(i.path) }) };
        case "LS":
            return { name: "ls", input: defined({ path: str(i.path) }) };
        case "WebFetch":
            return { name: "webfetch", input: defined({ url: str(i.url), prompt: str(i.prompt) }) };
        case "WebSearch":
            return { name: "websearch", input: defined({ query: str(i.query) }) };
        case "TodoWrite":
            return { name: "todo", input: { todos: Array.isArray(i.todos) ? i.todos : [] } };
        case "Task":
        case "Agent":
            return {
                name: "task",
                input: defined({ description: str(i.description), prompt: str(i.prompt), agent: str(i.subagent_type) }),
            };
        case "ExitPlanMode":
            return { name: "exit_plan_mode", input: defined({ plan: str(i.plan) }) };
        default:
            // mcp__server__tool → server__tool, the shape loop's MCP tools use.
            if (name.startsWith("mcp__")) return { name: name.slice("mcp__".length), input: rawInput ?? {} };
            return { name, input: rawInput ?? {} };
    }
}

/** Cursor's tool-call payload key (`shellToolCall`) plus its args. */
export function mapCursorTool(kind: string, rawArgs: unknown): MappedTool {
    const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Rec;
    switch (kind) {
        case "shell":
            return { name: "bash", input: defined({ command: str(a.command) }) };
        case "read":
            return { name: "read", input: defined({ path: str(a.path), offset: num(a.offset), limit: num(a.limit) }) };
        case "write":
            return { name: "write", input: { path: str(a.path), content: str(a.fileText) ?? str(a.contents) ?? "" } };
        case "edit":
            return {
                name: "edit",
                input: defined({
                    path: str(a.path),
                    edits:
                        str(a.oldString) !== undefined || str(a.old_string) !== undefined
                            ? [{ oldText: str(a.oldString) ?? str(a.old_string) ?? "", newText: str(a.newString) ?? str(a.new_string) ?? "" }]
                            : undefined,
                }),
            };
        case "ls":
            return { name: "ls", input: defined({ path: str(a.path) }) };
        case "glob":
            return { name: "find", input: defined({ pattern: str(a.globPattern) ?? str(a.pattern), path: str(a.targetDirectory) ?? str(a.path) }) };
        case "grep":
            return { name: "grep", input: defined({ pattern: str(a.pattern), path: str(a.path), glob: str(a.glob) }) };
        case "updateTodos":
            return { name: "todo", input: { todos: Array.isArray(a.todos) ? a.todos : [] } };
        case "task":
            return { name: "task", input: defined({ description: str(a.description), prompt: str(a.prompt) }) };
        case "mcp": {
            const server = str(a.providerIdentifier) ?? str(a.serverName) ?? "mcp";
            const tool = str(a.toolName) ?? str(a.name) ?? "tool";
            return { name: `${server}__${tool}`, input: a.args ?? a };
        }
        default:
            return { name: kind, input: rawArgs ?? {} };
    }
}
