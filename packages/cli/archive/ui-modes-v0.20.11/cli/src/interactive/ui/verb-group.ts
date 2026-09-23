/**
 * The verb-group vocabulary — how a run of tool rows becomes one honest line
 * of English: `Read 1 skill, Listed 2 dirs, Searched 1 pattern · 1 failed`.
 *
 * Ported from grok-build (`blocks/tool/mod.rs`), including the distinction
 * that makes the whole thing work: a tool is classified into a KIND, and the
 * kind decides both the grammar and whether a run of them folds into a header.
 *
 * Everything folds — reads, listings, searches, fetches, subagents, commands,
 * edits, and third-party calls — because a run's individual detail is noise you
 * can open the group to get back. The exceptions are not about noise at all:
 * `ask` and `plan` are surfaces the user has to act on, and one folded into a
 * count is one nobody answers.
 *
 * ## Tools we did not write
 *
 * Extensions and MCP servers introduce tools this file has never heard of, and
 * the classification must handle them by RULE rather than by guesswork. Three
 * layers, most specific first:
 *
 * 1. An explicit registration ({@link registerToolVerbGroup}) — a tool that
 *    knows what it does says so, and gets first-class grammar. This is the
 *    supported way for an extension to read as well as a builtin.
 * 2. {@link BUILTIN} — loop's own tools, named exactly.
 * 3. Otherwise it is somebody else's tool, and we say only what we actually
 *    know: whether it came over MCP (namespaced `server__tool`) or from an
 *    extension. Both fold.
 *
 * There used to be a fourth layer between 2 and 3: a heuristic that read a
 * leading verb off the name (`list_*` → dir, `search_*` → search). It was
 * removed because it produced both of the failures grouping is supposed to
 * avoid. Folding became a lottery on how a server had spelled things —
 * `sentry__list_errors` folded, `sentry__get_error` did not, from one server in
 * one run — and when it did fire it borrowed the BUILTIN's NOUN along with the
 * verb, so a run of Sentry lookups rendered as "Listed 2 dirs". A verb travels
 * to a third-party tool; the noun it was paired with does not. Saying "Called 2
 * MCP tools" knows less and claims exactly that much.
 */

/** A kind's grammar: tense-aware verb plus a singular/plural noun. */
export interface VerbGroupKind {
    /** Shown once the calls have finished ("Read"). */
    past: string;
    /** Shown while any member is still running ("Reading"). */
    present: string;
    nounOne: string;
    nounMany: string;
    /**
     * Whether a run of these collapses into a header on its own. False keeps
     * the rows visible; the kind is still used to NAME them inside a header
     * that hides them for another reason.
     */
    folds: boolean;
}

const KIND = {
    file: { past: "Read", present: "Reading", nounOne: "file", nounMany: "files", folds: true },
    skill: { past: "Read", present: "Reading", nounOne: "skill", nounMany: "skills", folds: true },
    dir: { past: "Listed", present: "Listing", nounOne: "dir", nounMany: "dirs", folds: true },
    search: { past: "Searched", present: "Searching", nounOne: "pattern", nounMany: "patterns", folds: true },
    web: { past: "Fetched", present: "Fetching", nounOne: "website", nounMany: "websites", folds: true },
    memory: { past: "Searched", present: "Searching", nounOne: "memory", nounMany: "memories", folds: true },
    subagent: { past: "Ran", present: "Running", nounOne: "subagent", nounMany: "subagents", folds: true },
    todo: { past: "Updated", present: "Updating", nounOne: "todo list", nounMany: "todo lists", folds: true },
    data: { past: "Queried", present: "Querying", nounOne: "datasource", nounMany: "datasources", folds: true },
    artifact: { past: "Created", present: "Creating", nounOne: "artifact", nounMany: "artifacts", folds: true },

    command: { past: "Ran", present: "Running", nounOne: "command", nounMany: "commands", folds: true },

    // Reading or killing a background shell — the noun is the shell, not the
    // command it is running (that row was already printed when it started).
    shell: { past: "Checked", present: "Checking", nounOne: "shell", nounMany: "shells", folds: true },

    // Tools we did not write, named by the only thing we reliably know about
    // them — where they came from. Both fold; see the layering note above.
    mcp: { past: "Called", present: "Calling", nounOne: "MCP tool", nounMany: "MCP tools", folds: true },
    extension: {
        past: "Called",
        present: "Calling",
        nounOne: "extension tool",
        nounMany: "extension tools",
        folds: true,
    },

    edit: { past: "Edited", present: "Editing", nounOne: "file", nounMany: "files", folds: true },

    // An ask folds only once it has been ANSWERED, which costs nothing to
    // arrange: a question still waiting on the user is `isPartial`, and a
    // running call is never groupable (see isGroupable). So `folds: true` here
    // never hides a live question — it only lets a settled one join the run
    // behind it, the way every other finished call does, carrying the answer
    // in its receipt.
    ask: { past: "Asked", present: "Asking", nounOne: "question", nounMany: "questions", folds: true },

    // A plan is the exception that stays: unlike a question it is not answered
    // and done with — it is a document the user goes back and re-reads while
    // the work proceeds against it, and it renders as full markdown rather
    // than a row (isPlanSurface). Folding it into a count would hide the one
    // thing on screen that the rest of the turn is judged against.
    plan: { past: "Planned", present: "Planning", nounOne: "plan", nounMany: "plans", folds: false },
} as const satisfies Record<string, VerbGroupKind>;

export type VerbGroupKindId = keyof typeof KIND;

/** loop's builtin tools. Anything absent is somebody else's tool. */
const BUILTIN: Record<string, VerbGroupKindId> = {
    read: "file",
    skill: "skill",
    ls: "dir",
    tree: "dir",
    glob: "search",
    grep: "search",
    find: "search",
    websearch: "search",
    webfetch: "web",
    memory: "memory",
    task: "subagent",
    todo: "todo",
    bash: "command",
    shells: "shell",
    edit: "edit",
    write: "edit",
    sql: "data",
    artifact: "artifact",
    ask: "ask",
    plan: "plan",
    enter_plan_mode: "plan",
    exit_plan_mode: "plan",
};

/**
 * The two tools whose INPUT is the deliverable — a plan document the user has
 * to read before deciding. Both render as full markdown in their box and
 * never fold into a group; a plan folded into a count is one nobody reads.
 * (`plan` ends the turn and hands off; `exit_plan_mode` lifts the gate and
 * keeps going — same surface, different exit.)
 */
export function isPlanSurface(toolName: string): boolean {
    return toolName === "plan" || toolName === "exit_plan_mode";
}

/** Explicit registrations — extensions naming their own tools' grammar. */
const registered = new Map<string, VerbGroupKindId>();

/**
 * Declare how a tool should be grouped and named:
 * `registerToolVerbGroup("fetch_issues", "web")`.
 *
 * This is the ONLY way a third-party tool gets a builtin's grammar, and it
 * beats every rule below it — deliberately, because a name is not evidence.
 * Without a registration a tool is described by where it came from, which is
 * the most we actually know about it.
 */
export function registerToolVerbGroup(toolName: string, kind: VerbGroupKindId): void {
    registered.set(toolName, kind);
}

/** Drop all registrations (extension reload, tests). */
export function clearToolVerbGroups(): void {
    registered.clear();
}

/** MCP tools arrive namespaced as `server__tool`. */
function isMcpToolName(toolName: string): boolean {
    return toolName.includes("__");
}

/** The kind id for a tool name — see the layering note at the top of the file. */
export function kindIdOf(toolName: string): VerbGroupKindId {
    const explicit = registered.get(toolName);
    if (explicit) return explicit;
    const builtin = BUILTIN[toolName];
    if (builtin) return builtin;
    // Not ours and not registered: say where it came from and nothing more.
    return isMcpToolName(toolName) ? "mcp" : "extension";
}

export function kindOf(toolName: string): VerbGroupKind {
    return KIND[kindIdOf(toolName)];
}

/** Whether a run of this tool collapses into a group header on its own. */
export function foldsEagerly(toolName: string): boolean {
    return kindOf(toolName).folds;
}

export interface GroupMember {
    toolName: string;
    isError: boolean;
    isRunning: boolean;
}

/**
 * The aggregated header text for a run: one segment per kind in first-seen
 * order, joined with ", ", plus a failure suffix when any member failed.
 *
 * Kinds are bucketed rather than tools, so `read` + `skill` read as
 * "Read 2 files, Read 1 skill" — two honest segments — while `grep` + `glob`
 * merge into one "Searched 2 patterns". Tense follows the run: any member
 * still running makes the whole label present-tense, because the run as a
 * whole is still happening.
 */
export function verbGroupLabel(members: GroupMember[]): { text: string; failed: number } {
    const running = members.some((m) => m.isRunning);
    const order: VerbGroupKindId[] = [];
    const counts = new Map<VerbGroupKindId, number>();
    let failed = 0;
    for (const m of members) {
        const id = kindIdOf(m.toolName);
        if (!counts.has(id)) order.push(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (m.isError) failed++;
    }
    const text = order
        .map((id) => {
            const kind = KIND[id];
            const n = counts.get(id)!;
            return `${running ? kind.present : kind.past} ${n} ${n === 1 ? kind.nounOne : kind.nounMany}`;
        })
        .join(", ");
    return { text, failed };
}
