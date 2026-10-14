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

/** A Codex `item` that is a tool, with the result once the item completed. */
export interface MappedCodexItem extends MappedTool {
    result?: unknown;
    isError?: boolean;
}

/**
 * Codex reports its work as typed items (`command_execution`, `file_change`,
 * …) rather than named tool calls; each becomes the loop tool doing that job.
 */
export function mapCodexItem(item: Rec): MappedCodexItem {
    switch (item.type) {
        case "command_execution": {
            const exit = num(item.exit_code);
            return {
                name: "bash",
                input: defined({ command: unwrapShell(str(item.command) ?? "") }),
                result: `${str(item.aggregated_output) ?? ""}${exit ? `\n[exit ${exit}]` : ""}`,
                isError: (exit !== undefined && exit !== 0) || item.status === "failed",
            };
        }
        case "file_change": {
            const changes = (Array.isArray(item.changes) ? item.changes : []) as Rec[];
            const paths = changes.map((c) => str(c.path)).filter((p): p is string => Boolean(p));
            const failed = item.status === "failed";
            // One file reads as an edit of it; several as one patch naming each.
            if (paths.length === 1) {
                const kind = str(changes[0].kind);
                return {
                    name: kind === "add" ? "write" : "edit",
                    input: { path: paths[0] },
                    result: failed ? "patch failed" : `${kind ?? "update"} ${paths[0]}`,
                    isError: failed,
                };
            }
            return {
                name: "apply_patch",
                input: { files: changes.map((c) => ({ path: str(c.path), kind: str(c.kind) })) },
                result: failed ? "patch failed" : changes.map((c) => `${str(c.kind) ?? "update"} ${str(c.path)}`).join("\n"),
                isError: failed,
            };
        }
        case "mcp_tool_call": {
            const error = (item.error as Rec | undefined)?.message;
            return {
                name: `${str(item.server) ?? "mcp"}__${str(item.tool) ?? "tool"}`,
                input: item.arguments ?? {},
                result: error ?? item.result ?? "",
                isError: error !== undefined || item.status === "failed",
            };
        }
        case "web_search":
            return { name: "websearch", input: defined({ query: str(item.query) }), result: "" };
        case "todo_list": {
            const items = (Array.isArray(item.items) ? item.items : []) as Rec[];
            return {
                name: "todo",
                input: {
                    todos: items.map((t) => ({ content: str(t.text) ?? "", status: t.completed === true ? "completed" : "pending" })),
                },
                result: "",
            };
        }
        default:
            return { name: str(item.type) ?? "tool", input: item, result: "" };
    }
}

/** `/bin/zsh -lc "ls -la"` → `ls -la`: Codex reports the shell wrapper it ran. */
export function unwrapShell(command: string): string {
    const m = /^\S*\/(?:ba|z)?sh\s+-l?c\s+(["'])([^]*)\1$/.exec(command.trim());
    if (!m) return command;
    return m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, "$1") : m[2];
}

/**
 * Antigravity's (`agy`) tool names and PascalCase parameters. It reports
 * paths but not the text it wrote, so edits carry the path alone.
 */
export function mapAntigravityTool(name: string, rawParams: unknown): MappedTool {
    const p = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Rec;
    switch (name) {
        case "run_command":
            return { name: "bash", input: defined({ command: str(p.CommandLine) ?? str(p.Command) }) };
        case "view_file": {
            const start = num(p.StartLine);
            const end = num(p.EndLine);
            return {
                name: "read",
                input: defined({
                    path: str(p.AbsolutePath) ?? str(p.File),
                    offset: start,
                    limit: start !== undefined && end !== undefined ? end - start + 1 : undefined,
                }),
            };
        }
        case "write_to_file":
            return { name: "write", input: defined({ path: str(p.TargetFile), content: str(p.CodeContent) }) };
        case "replace_file_content":
        case "multi_replace_file_content":
        case "sed_file": {
            const chunks = (Array.isArray(p.ReplacementChunks) ? p.ReplacementChunks : []) as Rec[];
            const edits = chunks.length
                ? chunks.map((c) => ({ oldText: str(c.TargetContent) ?? "", newText: str(c.ReplacementContent) ?? "" }))
                : str(p.TargetContent) !== undefined
                  ? [{ oldText: str(p.TargetContent) ?? "", newText: str(p.ReplacementContent) ?? "" }]
                  : undefined;
            return { name: "edit", input: defined({ path: str(p.TargetFile), edits }) };
        }
        case "list_dir":
            return { name: "ls", input: defined({ path: str(p.DirectoryPath) }) };
        case "grep_search":
            return { name: "grep", input: defined({ pattern: str(p.Query), path: str(p.SearchPath), glob: str(p.Includes) }) };
        case "find_by_name":
            return { name: "find", input: defined({ pattern: str(p.Pattern), path: str(p.SearchDirectory) }) };
        case "search_web":
            return { name: "websearch", input: defined({ query: str(p.query) ?? str(p.Query) }) };
        case "read_url_content":
            return { name: "webfetch", input: defined({ url: str(p.Url) ?? str(p.url) }) };
        case "call_mcp_tool":
            return {
                name: `${str(p.ServerName) ?? "mcp"}__${str(p.ToolName) ?? "tool"}`,
                input: p.Arguments ?? {},
            };
        case "invoke_subagent":
            return { name: "task", input: defined({ description: str(p.Description), prompt: str(p.Prompt) ?? str(p.Task) }) };
        default:
            return { name, input: rawParams ?? {} };
    }
}
