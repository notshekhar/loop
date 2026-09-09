/**
 * Internal docs surfaced through the read tool's `loop://docs/...` scheme.
 *
 * Doc bodies live in `.md` files next to this one and are inlined into the
 * bundle via the generated `generated.ts` string map (run `bun run gen:docs`
 * after editing any .md). Keeping the bodies in generated.ts — rather than an
 * `import ... with { type: "text" }` — avoids import attributes that some TS
 * language servers reject. To add a doc: drop a `.md` file here, re-run
 * gen:docs, and add a SUMMARIES entry. `loop://docs` lists them.
 */
import { PRODUCT_NAME } from "../brand";
import { DOCS_CONTENT } from "./generated";

export interface DocEntry {
    /** Filename used in the URI, e.g. "config.md". */
    name: string;
    /** One-line description shown in the `loop://docs` index. */
    summary: string;
    /** Full markdown body. */
    content: string;
}

/** One-line descriptions for the `loop://docs` index, keyed by filename. */
const SUMMARIES: Record<string, string> = {
    "handoff.md": "Continue the current task in a fresh session with /handoff: reviewed brief, source link, model and agent selection.",
    "recipes.md": "Save a session as a reusable /recipe workflow, edit its Markdown, and run it with named or positional inputs.",
    "config.md": `Configure ${PRODUCT_NAME} by editing its JSON/markdown config yourself: add models, custom providers, datasources (database connections for the sql tool), hooks, MCP servers, and custom agents.`,
    "permissions.md": `How ${PRODUCT_NAME} decides whether a tool call runs: allow/ask/deny rule syntax and evaluation order, bash guardrails, per-project grants, the sandbox, and plan mode.`,
    "extensions.md": `Write a ${PRODUCT_NAME} extension (Bun/TS): add or override slash commands, tools, providers + models, agents, skills, settings, the system prompt, and the turn loop.`,
    "lua.md": `Script ${PRODUCT_NAME} in Lua — READ THIS BEFORE BUILDING AN EXTENSION when asked for a widget, panel, terminal, keybinding or status-line addition. Write one .lua file into ~/.loop/lua/ and run /reload: no package, no install, no build step. Covers widgets, docked panels, a real terminal, mouse and dragging, keymaps, timers and subprocesses.`,
};

export const DOCS: Record<string, DocEntry> = Object.fromEntries(
    Object.entries(DOCS_CONTENT).map(([name, content]) => [name, { name, summary: SUMMARIES[name] ?? name, content }]),
);

export function listDocs(): DocEntry[] {
    return Object.values(DOCS);
}

/** Look up a doc by name; `.md` suffix is optional in the lookup. */
export function getDoc(name: string): DocEntry | undefined {
    const key = name.endsWith(".md") ? name : `${name}.md`;
    return DOCS[key];
}

/** Rendered index for `loop://docs` — the discovery entry point for agents. */
export function renderDocsIndex(): string {
    const lines = listDocs().map((d) => `- ${PRODUCT_NAME}://docs/${d.name} — ${d.summary}`);
    return [
        `Internal ${PRODUCT_NAME} docs. Read one with the read tool, e.g. read ${PRODUCT_NAME}://docs/config.md`,
        "",
        ...lines,
    ].join("\n");
}
