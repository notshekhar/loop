/**
 * LSP extension — code intelligence, in two halves.
 *
 * 1. Ambient diagnostics: after a `write` or `edit`, the changed file is run
 *    through every language server that handles it and the errors are appended
 *    to the tool result, so the agent sees what it just broke without being
 *    asked to go check. This is the half that changes behavior most, and it
 *    costs nothing when the file is clean.
 * 2. The `lsp` tool: nine navigation operations (definition, references, hover,
 *    symbols, implementation, call hierarchy) that answer semantically where
 *    `grep` can only answer textually.
 *
 * Everything rides the extension API: `onResult` for the diagnostics seam,
 * `tools.add` for the tool, `getOwn` for settings, and `deactivate` to reap the
 * server processes.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ExtensionAPI, ToolSummaryContext } from "../../api";
import { getLspManager, shutdownAllManagers } from "./manager";
import { LSP_OPERATIONS, type LspOperation, needsPosition, runOperation } from "./operations";
import { type Diagnostic, SEVERITY_LABEL } from "./protocol";

/** Errors only. Warnings are mostly style, and the agent acts on everything it is shown. */
const REPORTED_SEVERITY = 1;
/** Cap per file, so one catastrophically broken file can't flood the turn. */
const MAX_PER_FILE = 20;

function prettyDiagnostic(d: Diagnostic): string {
    const severity = SEVERITY_LABEL[d.severity ?? 1].toUpperCase();
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    return `${severity} [${line}:${col}] ${d.message.replace(/\s+/g, " ").trim()}`;
}

/** The `<diagnostics>` block appended to a write/edit result. Empty when clean. */
export function reportDiagnostics(cwd: string, absPath: string, diagnostics: Diagnostic[]): string {
    const errors = diagnostics.filter((d) => (d.severity ?? 1) === REPORTED_SEVERITY);
    if (errors.length === 0) return "";
    const rel = relative(cwd, absPath).replace(/\\/g, "/") || absPath;
    const shown = errors.slice(0, MAX_PER_FILE);
    const more = errors.length - shown.length;
    const suffix = more > 0 ? `\n... and ${more} more` : "";
    return `<diagnostics file="${rel}">\n${shown.map(prettyDiagnostic).join("\n")}${suffix}\n</diagnostics>`;
}

const OPERATION_HELP = `Answer a question about code exactly, from the compiler's own model of the
project. Use it whenever you need to be precisely right about a symbol rather
than approximately right:

- Where is this defined? -> goToDefinition
- Who uses this / what breaks if I change it? -> findReferences, incomingCalls
- What type is this, what does it do? -> hover (signature, type, doc comment)
- What implements this interface or abstract method? -> goToImplementation
- What does this function call? -> outgoingCalls
- What is in this file? -> documentSymbol (outline of every symbol, with lines)
- Where is the symbol named X, anywhere in the project? -> workspaceSymbol

Reach for it whenever precision is what the task needs: before renaming a
symbol, changing a function signature, deleting something that looks dead, or
tracing how a value flows. Every answer resolves the real symbol, so it covers
that symbol's re-exports and aliases and leaves out everything that merely
shares its spelling — and incomingCalls answers a question no text search can
express.

Positions: pass filePath, line (1-based, exactly as read and grep report it) and
symbol — the name at that line — and the column is resolved for you, so never
count characters. Pass character only when you already know the exact 1-based
column; symbol wins if both are given.

documentSymbol needs only filePath. workspaceSymbol needs only query (empty
string requests every symbol); its filePath merely picks which server answers
and may be a directory or omitted. prepareCallHierarchy just resolves the
callable at a position — incomingCalls and outgoingCalls do that step
themselves, so you rarely want it directly.

A language server must be configured for the file type; if none is available the
tool says so.`;

/**
 * The one-line summary shown beside an `lsp` call. The default for a tool loop
 * doesn't ship is a truncated JSON dump of the arguments, which for a 5-field
 * call is unreadable — so the extension renders its own:
 *
 *   goToDefinition · src/main.ts:4 greet
 *   findReferences · src/main.ts:4:23
 *   workspaceSymbol · "greet"
 *   documentSymbol · src/main.ts
 *
 * Colour follows the active theme, and `noir` gets the operation in bold to
 * match its heavier row grammar; `loop` stays flat.
 */
export function summarizeLspCall(args: Record<string, unknown>, ctx: ToolSummaryContext): string {
    const operation = typeof args.operation === "string" ? args.operation : "lsp";
    const filePath = typeof args.filePath === "string" ? args.filePath : "";
    const rel = filePath.startsWith(ctx.cwd) ? filePath.slice(ctx.cwd.length).replace(/^[/\\]/, "") : filePath;

    let target: string;
    if (operation === "workspaceSymbol") {
        const query = typeof args.query === "string" ? args.query : "";
        target = query ? `"${query}"` : "(all symbols)";
    } else if (typeof args.line === "number" && typeof args.symbol === "string") {
        // The column is resolved inside execute, so the symbol is all we can
        // name here — and it reads better than a column would have.
        target = `${rel}:${args.line} ${args.symbol}`;
    } else if (typeof args.line === "number" && typeof args.character === "number") {
        target = `${rel}:${args.line}:${args.character}`;
    } else if (typeof args.line === "number") {
        target = `${rel}:${args.line}`;
    } else {
        target = rel;
    }

    const op = ctx.theme.bold(operation);
    return target ? `${op} ${ctx.theme.fg("muted", "·")} ${target}` : op;
}

/**
 * Turn `symbol` into a 1-based column on `line`.
 *
 * The model is handed line numbers by `read` and `grep` but never columns, so
 * asking it for `character` asks it to count into a line by eye. A wrong guess
 * lands on whitespace and comes back "No results found", which reads like the
 * tool failing rather than the position being off — and one of those is enough
 * to send it back to grep for the rest of the session. Naming the symbol
 * removes the guess.
 */
export async function resolveColumn(
    file: string,
    line: number,
    symbol: string,
): Promise<{ character: number } | { error: string }> {
    let text: string;
    try {
        text = await readFile(file, "utf8");
    } catch {
        return { error: `[cannot read ${file} to locate "${symbol}"]` };
    }
    const lines = text.split(/\r?\n/);
    const target = lines[line - 1];
    if (target === undefined) {
        return { error: `[line ${line} is past the end of ${file} (${lines.length} lines)]` };
    }
    // Word boundaries stop `run` from matching inside `runTurn`, but only help
    // where the symbol's own edges are word characters: `#private` or `foo!`
    // would never match with \b bolted on regardless.
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const left = /^\w/.test(symbol) ? "\\b" : "";
    const right = /\w$/.test(symbol) ? "\\b" : "";
    const match = new RegExp(`${left}${escaped}${right}`).exec(target);
    if (!match) {
        return { error: `["${symbol}" is not on line ${line}, which reads: ${target.trim()}]` };
    }
    return { character: match.index + 1 };
}

function buildLspTool(cwd: () => string) {
    return tool({
        description: OPERATION_HELP,
        inputSchema: z.object({
            operation: z
                .enum(LSP_OPERATIONS)
                .describe("Which question to answer — see the description for what each operation resolves"),
            filePath: z
                .string()
                .optional()
                .describe(
                    "Path to the file. For workspaceSymbol this may be a directory (or omitted, meaning the workspace) — it only selects which language server answers.",
                ),
            line: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(
                    "Line number, 1-based, exactly as read and grep report it. Required for position operations.",
                ),
            symbol: z
                .string()
                .optional()
                .describe(
                    'The name at that line to point at, e.g. "runTurn" — its column is resolved for you, so you never have to count characters. First occurrence on the line wins. Preferred over character.',
                ),
            character: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(
                    "Column, 1-based. Only needed when you already know the exact column — e.g. to reach the second occurrence of a name on one line. Otherwise pass symbol instead.",
                ),
            query: z
                .string()
                .optional()
                .describe("Search query for workspaceSymbol. Empty string requests all symbols."),
        }),
        execute: async ({ operation, filePath, line, symbol, character, query }) => {
            const root = cwd();
            const op = operation as LspOperation;
            // workspaceSymbol is about a whole project, so the path is only a
            // server selector and may be omitted entirely — default to the cwd.
            const target = filePath ?? (op === "workspaceSymbol" ? "." : undefined);
            if (target === undefined) return `[${op} needs filePath]`;
            const abs = isAbsolute(target) ? target : join(root, target);

            // `symbol` is the intended way in; `character` outranks nothing and
            // survives only as the escape hatch for a repeated name on one line.
            let column = character;
            if (needsPosition(op)) {
                if (line === undefined) {
                    return `[${op} needs line, plus symbol (the name at that line) or character]`;
                }
                if (symbol !== undefined) {
                    const resolved = await resolveColumn(abs, line, symbol);
                    if ("error" in resolved) return resolved.error;
                    column = resolved.character;
                }
                if (column === undefined) {
                    return `[${op} needs symbol (the name at line ${line}) or character (1-based column)]`;
                }
            }
            const manager = getLspManager(root);
            // Accepts a directory as well as a file: workspaceSymbol is normally
            // asked about a project, not a particular source file.
            const clients = await manager.clientsForTarget(abs);
            if (clients.length === 0) {
                return `[no language server available for ${target}. Install one for this file type, or add it to ~/.loop/servers/servers.json]`;
            }

            // A request only answers about an open document — including
            // workspace/symbol, whose index is built from the loaded project.
            // A no-op when `abs` is a directory (clientsForTarget primed those).
            await Promise.all(clients.map(({ client }) => client.openDocument(abs)));

            const input = { operation: op, file: abs, line: line ?? 1, character: column ?? 1, query };
            const results = await Promise.all(
                clients.map(async ({ key, client }) => ({ key, ...(await runOperation(client, input, root)) })),
            );

            const lines = results.flatMap((r) => r.lines);
            if (lines.length === 0) {
                const all = results.every((r) => r.unsupported);
                if (all) {
                    const names = results.map((r) => r.key).join(", ");
                    return `[${op} is not supported by the language server for this file (${names})]`;
                }
                return `No results found for ${op}`;
            }
            // Dedupe: several servers answering one file repeat each other.
            return [...new Set(lines)].join("\n");
        },
    });
}

export default {
    activate(api: ExtensionAPI) {
        const enabled = () => api.settings.getOwn<boolean>("enabled", true) !== false;

        // After write/edit, diagnose the file on disk (works for both: the tool
        // has already written it). Appends a diagnostics block, or leaves the
        // result untouched when clean / unsupported / disabled. Never throws — a
        // diagnostics failure must not break an edit.
        api.tools.onResult(["write", "edit"], async (result, ctx) => {
            if (!enabled() || ctx.signal?.aborted) return;
            const rawPath = (ctx.input as { path?: string } | undefined)?.path;
            if (!rawPath) return;
            const absPath = isAbsolute(rawPath) ? rawPath : join(ctx.cwd, rawPath);
            try {
                const content = await readFile(absPath, "utf8");
                const diagnostics = await getLspManager(ctx.cwd).diagnose(absPath, content);
                const block = reportDiagnostics(ctx.cwd, absPath, diagnostics);
                if (!block) return;
                return `${result}\n\nLSP errors detected in this file, please fix:\n${block}`;
            } catch {
                return; // fail-open
            }
        });

        if (!enabled()) return;

        // Reading a file warms its server in the background, so the diagnostics
        // after the NEXT edit are already waiting instead of paying startup.
        api.tools.onResult("read", (_result, ctx) => {
            const rawPath = (ctx.input as { path?: string } | undefined)?.path;
            if (!rawPath || /^[a-z]+:\/\//i.test(rawPath)) return;
            const absPath = isAbsolute(rawPath) ? rawPath : join(ctx.cwd, rawPath);
            void getLspManager(ctx.cwd)
                .clientsFor(absPath)
                .catch(() => {});
        });

        let toolCwd = process.cwd();
        api.turn.use({
            onBeforeTurn(ctx) {
                toolCwd = ctx.cwd;
            },
        });
        api.tools.add(
            "lsp",
            buildLspTool(() => toolCwd),
        );
        // The read-only plan agent benefits most from navigation, and the tool
        // cannot mutate anything.
        // Own the tool's presentation too — the default renderer would print a
        // JSON dump of the arguments.
        api.tools.summary("lsp", summarizeLspCall);
        // The read-only plan agent benefits most from navigation, and the tool
        // cannot mutate anything.
        api.tools.grant("plan", "lsp");
    },

    async deactivate() {
        await shutdownAllManagers();
    },
};
