/**
 * Runs of finished tool calls, as one line of English.
 *
 * This is a port of `packages/cli/src/interactive/ui/verb-group.ts`, which is
 * what the terminal folds a transcript with: a tool is classified
 * into a KIND, kinds carry a tense-aware verb and a noun, and a run of adjacent
 * calls becomes `Read 2 files, Listed 1 dir`. The web is a second surface for
 * the same transcript and has to agree with the terminal about what a run is
 * called, so the vocabulary is reproduced here rather than reinvented.
 *
 * Ported rather than imported for the same reason as `loopToolSummary.ts`: the
 * CLI module lives in a tree that reaches for the extension host and the ANSI
 * theme. Only the grammar comes across.
 *
 * KEEP IN SYNC with the CLI module: if loop grows a tool, both need the case.
 * `packages/cli/test/web-port-parity.test.ts` enforces it — it imports both
 * copies and requires them to classify and label every tool identically.
 *
 * The one thing NOT ported is the CLI's `registerToolVerbGroup` seam, which
 * exists for extensions — CLI-side code that cannot run in a browser. A tool
 * registered there classifies by source here instead ("Called 2 extension
 * tools"), so a registration makes the terminal's label more specific than the
 * web's for the same run. Both fold it the same way, so the shape of the
 * transcript still agrees.
 */

/** A kind's grammar: tense-aware verb plus a singular/plural noun. */
export interface VerbGroupKind {
  /** Shown once the calls have finished ("Read"). */
  readonly past: string;
  /** Shown while any member is still running ("Reading"). */
  readonly present: string;
  readonly nounOne: string;
  readonly nounMany: string;
  /**
   * Whether a run of these collapses into a header on its own. False keeps the
   * rows visible; the kind is still used to NAME them inside a header that
   * hides them for another reason.
   */
  readonly folds: boolean;
}

const KIND = {
  file: { past: "Read", present: "Reading", nounOne: "file", nounMany: "files", folds: true },
  skill: { past: "Read", present: "Reading", nounOne: "skill", nounMany: "skills", folds: true },
  dir: { past: "Listed", present: "Listing", nounOne: "dir", nounMany: "dirs", folds: true },
  search: {
    past: "Searched",
    present: "Searching",
    nounOne: "pattern",
    nounMany: "patterns",
    folds: true,
  },
  web: {
    past: "Fetched",
    present: "Fetching",
    nounOne: "website",
    nounMany: "websites",
    folds: true,
  },
  memory: {
    past: "Searched",
    present: "Searching",
    nounOne: "memory",
    nounMany: "memories",
    folds: true,
  },
  subagent: {
    past: "Ran",
    present: "Running",
    nounOne: "subagent",
    nounMany: "subagents",
    folds: true,
  },
  todo: {
    past: "Updated",
    present: "Updating",
    nounOne: "todo list",
    nounMany: "todo lists",
    folds: true,
  },
  data: {
    past: "Queried",
    present: "Querying",
    nounOne: "datasource",
    nounMany: "datasources",
    folds: true,
  },
  artifact: {
    past: "Created",
    present: "Creating",
    nounOne: "artifact",
    nounMany: "artifacts",
    folds: true,
  },

  command: {
    past: "Ran",
    present: "Running",
    nounOne: "command",
    nounMany: "commands",
    folds: true,
  },

  // Reading or killing a background shell — the noun is the shell, not the
  // command it is running (that row was already printed when it started).
  shell: { past: "Checked", present: "Checking", nounOne: "shell", nounMany: "shells", folds: true },

  // Tools we did not write, named by the only thing we reliably know about
  // them — where they came from. Both fold.
  mcp: {
    past: "Called",
    present: "Calling",
    nounOne: "MCP tool",
    nounMany: "MCP tools",
    folds: true,
  },
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
  // running call is never groupable. So `folds: true` here never hides a live
  // question — it only lets a settled one join the run behind it, the way
  // every other finished call does, carrying the answer in its receipt.
  ask: {
    past: "Asked",
    present: "Asking",
    nounOne: "question",
    nounMany: "questions",
    folds: true,
  },

  // A plan is the exception that stays: unlike a question it is not answered
  // and done with — it is a document the user goes back and re-reads while the
  // work proceeds against it. Folding it into a count would hide the one thing
  // on screen that the rest of the turn is judged against.
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
 * to read before deciding. Neither ever folds into a count.
 */
export function isPlanSurface(toolName: string): boolean {
  return toolName === "plan" || toolName === "exit_plan_mode";
}

/** MCP tools arrive namespaced as `server__tool`. */
function isMcpToolName(toolName: string): boolean {
  return toolName.includes("__");
}

/** The kind id for a tool name — see the layering note at the top of the file. */
export function kindIdOf(toolName: string): VerbGroupKindId {
  const builtin = BUILTIN[toolName];
  if (builtin) return builtin;
  // Not ours: say where it came from and nothing more.
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
  readonly toolName: string;
  readonly isError: boolean;
  readonly isRunning: boolean;
}

/**
 * The aggregated header text for a run: one segment per kind in first-seen
 * order, joined with ", ", plus the count of members that failed.
 *
 * Kinds are bucketed rather than tools, so `read` + `skill` read as "Read 2
 * files, Read 1 skill" — two honest segments — while `grep` + `glob` merge into
 * one "Searched 2 patterns".
 */
export function verbGroupLabel(members: readonly GroupMember[]): {
  text: string;
  failed: number;
} {
  const running = members.some((member) => member.isRunning);
  const order: VerbGroupKindId[] = [];
  const counts = new Map<VerbGroupKindId, number>();
  let failed = 0;
  for (const member of members) {
    const id = kindIdOf(member.toolName);
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (member.isError) failed++;
  }
  const text = order
    .map((id) => {
      const kind = KIND[id];
      const n = counts.get(id) ?? 0;
      return `${running ? kind.present : kind.past} ${n} ${n === 1 ? kind.nounOne : kind.nounMany}`;
    })
    .join(", ");
  return { text, failed };
}

/** The shape of a tool call this module needs to place it in a run. */
export interface GroupableTool {
  readonly name: string;
  readonly isError: boolean;
  readonly isPartial: boolean;
}

/**
 * Whether a row may be swallowed into a group.
 *
 * A RUNNING call never groups: it is the one row worth watching mid-turn, and
 * "Reading 3 files" would not say which. It joins the header once it lands.
 * The plan surfaces (`plan`, `exit_plan_mode`) never join either — they are
 * approval surfaces that must stay readable, and the timeline routes them to
 * their own card anyway.
 *
 * The last gate is the KIND. Every kind folds — reads, commands, edits,
 * third-party calls — except the surfaces the user has to act on (`ask`,
 * `plan`), which a count would hide.
 */
export function isGroupableTool(tool: GroupableTool): boolean {
  return !tool.isPartial && !isPlanSurface(tool.name) && foldsEagerly(tool.name);
}

export type ToolRun<T> =
  | { readonly kind: "single"; readonly item: T }
  | {
      readonly kind: "group";
      readonly items: readonly T[];
      readonly label: string;
      readonly failed: number;
    };

/**
 * Fold a list of work-log items into runs, in order.
 *
 * One member is enough to fold, as in the terminal (grok's `RunScan::folds`):
 * "Read 1 file" is already tighter than the row it replaces, and folding from
 * the first call means a second one joins an existing header instead of the
 * row visibly collapsing under the reader.
 *
 * `toolOf` returns null for an item that is not a loop tool call (an approval,
 * a hook line, a compaction) — those break a run, because a header that
 * swallowed them would be describing calls that are not there.
 */
export function groupToolRuns<T>(
  items: readonly T[],
  toolOf: (item: T) => GroupableTool | null,
): Array<ToolRun<T>> {
  const runs: Array<ToolRun<T>> = [];
  let open: T[] = [];
  let members: GroupMember[] = [];

  const close = (): void => {
    if (open.length === 0) return;
    const { text, failed } = verbGroupLabel(members);
    runs.push({ kind: "group", items: open, label: text, failed });
    open = [];
    members = [];
  };

  for (const item of items) {
    const tool = toolOf(item);
    if (tool && isGroupableTool(tool)) {
      open.push(item);
      members.push({ toolName: tool.name, isError: tool.isError, isRunning: tool.isPartial });
      continue;
    }
    close();
    runs.push({ kind: "single", item });
  }
  close();
  return runs;
}
