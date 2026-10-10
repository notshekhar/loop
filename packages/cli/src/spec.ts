/**
 * The CLI's command and flag surface, as data.
 *
 * One table drives three things that used to drift apart: what the parser
 * knows about flag arity (args.ts), what dispatch accepts (cli.ts), and what
 * the shells complete (completion.ts). Before this existed, an unknown command
 * fell through to the interactive TUI and an unknown flag was silently kept —
 * so `loop sesions` opened a chat and `--modle gpt-5` ran a whole turn on the
 * default model.
 *
 * It imports nothing on purpose: cli.ts pulls it in on the `--version` /
 * `--help` fast path, which must not drag in core (~400ms of module eval).
 */

/**
 * Arity is global (one flag name means one thing everywhere), which is what
 * lets the parser decide whether `--model x` consumes `x` before it has
 * resolved which command is running. Per-command acceptance is separate — see
 * `CommandSpec.flags`.
 */
export interface FlagSpec {
    /** Flag name without the leading `--`. */
    name: string;
    /** Single-character alias without the leading `-`, if any. */
    short?: string;
    /**
     * A value flag consumes the following token; a boolean flag never does.
     * Getting this wrong is how `loop goals rm --force <id>` used to swallow
     * the id as the value of `--force`.
     */
    takesValue: boolean;
    description: string;
    /** Accepted values. A value outside the list is a usage error. */
    choices?: readonly string[];
}

export interface CommandSpec {
    name: string;
    description: string;
    /** Alternate spellings that dispatch to the same command. */
    aliases?: string[];
    /** Fixed words that may follow the command (completion + help only). */
    subcommands?: string[];
    /** Flag names (without `--`) this command accepts, beyond the globals. */
    flags?: string[];
    /**
     * The command parses its own argv (mcp) — stop flag parsing at its name
     * and hand the rest through untouched rather than rejecting flags this
     * table has never heard of.
     */
    passthrough?: boolean;
    /** Kept working for back-compat, but left out of listings. */
    hidden?: boolean;
}

/**
 * How `loop run` reports what happened.
 *
 * `text` is the human stream (model output on stdout, activity on stderr).
 * The other two exist because scripts had no honest way to read a run: they
 * had to scrape `[tool:...]` lines out of stderr.
 */
export const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Every flag the CLI reads, in one place. */
export const FLAG_SPECS: Record<string, FlagSpec> = {
    help: { name: "help", short: "h", takesValue: false, description: "Show help" },
    version: { name: "version", short: "v", takesValue: false, description: "Print version" },
    model: { name: "model", takesValue: true, description: "Override the model (provider/id)" },
    provider: { name: "provider", takesValue: true, description: "Override the active provider" },
    cwd: { name: "cwd", takesValue: true, description: "Working directory" },
    session: { name: "session", takesValue: true, description: "Resume a session by id" },
    "max-steps": { name: "max-steps", takesValue: true, description: "Cap agent steps in run mode" },
    "output-format": {
        name: "output-format",
        takesValue: true,
        choices: OUTPUT_FORMATS,
        description: "How run mode reports: text, json (one object at the end), stream-json (NDJSON events)",
    },
    all: { name: "all", takesValue: false, description: "Include archived sessions" },
    archived: { name: "archived", takesValue: false, description: "Only archived sessions" },
    force: { name: "force", takesValue: false, description: "Reinstall even if already up to date" },
    install: { name: "install", takesValue: false, description: "Write the man page to the manpath" },
    path: { name: "path", takesValue: false, description: "Print the man page source instead of opening it" },
    socket: { name: "socket", takesValue: false, description: "Listen on a unix socket instead of stdio" },
    terminal: {
        name: "terminal",
        takesValue: false,
        description: "serve: offer the terminal to other devices even if /settings turned it off",
    },
    "no-terminal": {
        name: "no-terminal",
        takesValue: false,
        description: "serve: keep the terminal to this machine (paired devices get chat only)",
    },
    host: { name: "host", takesValue: true, description: "Interface to bind (default 0.0.0.0)" },
    port: { name: "port", takesValue: true, description: "Port to bind" },
    every: { name: "every", takesValue: true, description: "Run on an interval (30m, 2h, 1d)" },
    cron: { name: "cron", takesValue: true, description: "Run on a cron expression" },
    at: { name: "at", takesValue: true, description: 'Run once at a time ("18:30", "45m")' },
    agent: { name: "agent", takesValue: true, description: "Named agent to run as" },
};

/** Accepted with or without a command — including bare `loop`. */
export const GLOBAL_FLAGS = ["help", "version"] as const;

/** Accepted by bare `loop` (the interactive TUI), on top of the globals. */
export const INTERACTIVE_FLAGS = ["model", "provider", "cwd", "session"] as const;

/** Every command `loop` dispatches, in the order `loop --help` lists them. */
export const COMMANDS: CommandSpec[] = [
    {
        name: "run",
        description: "Run a single prompt and exit",
        flags: ["model", "cwd", "session", "max-steps", "output-format"],
    },
    { name: "login", description: "Configure provider auth" },
    { name: "logout", description: "Remove provider auth" },
    { name: "sessions", description: "List sessions in the current directory", flags: ["all", "archived"] },
    { name: "archive", description: "Archive a session (hide it from the lists)" },
    { name: "unarchive", description: "Restore an archived session" },
    { name: "artifacts", description: "List pages the agent wrote", subcommands: ["export"] },
    { name: "models", description: "List available models" },
    { name: "whoami", description: "Show active provider and auth status" },
    { name: "cost", description: "Cost ledger tools", subcommands: ["audit"] },
    {
        name: "goals",
        description: "Manage background tasks",
        aliases: ["background"],
        subcommands: ["list", "add", "rm", "run", "tick", "daemon"],
        flags: ["every", "cron", "at", "cwd", "model", "agent"],
    },
    {
        name: "mcp",
        description: "Manage MCP servers",
        subcommands: ["add", "add-json", "list", "get", "remove", "enable", "disable", "login"],
        // cmdMcp re-reads process.argv and runs its own parser.
        passthrough: true,
    },
    {
        name: "gateways",
        description: "Run remote chat gateways",
        // `gateway` is the singular slip; `telegram` predates the generic command.
        aliases: ["gateway", "telegram"],
        subcommands: ["status", "stop", "telegram"],
    },
    { name: "serve", description: "Web UI + WebSocket RPC", flags: ["host", "port", "terminal", "no-terminal"] },
    { name: "rpc", description: "JSON-RPC server", subcommands: ["stop"], flags: ["socket"] },
    { name: "install", description: "Install an extension" },
    { name: "link", description: "Link a local extension" },
    { name: "remove", description: "Remove an extension", aliases: ["uninstall"] },
    { name: "extensions", description: "List installed extensions" },
    { name: "enable", description: "Enable an extension" },
    { name: "disable", description: "Disable an extension" },
    { name: "completion", description: "Print a shell completion script", subcommands: ["bash", "zsh", "fish"] },
    { name: "man", description: "Open the manual", flags: ["install", "path"] },
    { name: "upgrade", description: "Update to the latest release", aliases: ["update"], flags: ["force"] },
    { name: "version", description: "Print version" },
    { name: "help", description: "Show help" },
];

/** Resolve a word to its command, following aliases. */
export function findCommand(word: string): CommandSpec | undefined {
    return COMMANDS.find((c) => c.name === word || c.aliases?.includes(word));
}

/** Flag names one command accepts: its own, plus the globals. */
export function allowedFlags(cmd: CommandSpec | undefined): Set<string> {
    const names = cmd ? (cmd.flags ?? []) : INTERACTIVE_FLAGS;
    return new Set<string>([...GLOBAL_FLAGS, ...names]);
}

/**
 * Which commands accept a flag — empty for the globals, which are accepted
 * everywhere. Used by the man page to say where a flag belongs.
 */
export function commandsForFlag(name: string): string[] {
    if ((GLOBAL_FLAGS as readonly string[]).includes(name)) return [];
    const owners = COMMANDS.filter((c) => c.flags?.includes(name)).map((c) => c.name);
    if ((INTERACTIVE_FLAGS as readonly string[]).includes(name)) owners.unshift("(no command)");
    return owners;
}

/** Short-flag letter → full flag name, for the flags that have one. */
export function flagForShort(letter: string): FlagSpec | undefined {
    return Object.values(FLAG_SPECS).find((f) => f.short === letter);
}

/**
 * Levenshtein distance, capped: we only ever ask "is this within 2 edits",
 * so the row-by-row minimum lets a hopeless candidate bail early.
 */
function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
            if (row[j] < best) best = row[j];
        }
        if (best > max) return max + 1;
        prev = row;
    }
    return prev[b.length];
}

/** The closest candidate within a small edit distance, or undefined. */
function closest(word: string, candidates: Iterable<string>): string | undefined {
    // Two edits catches the realistic typo (sesions, modle, artifcats) without
    // "did you mean run?" for a word that shares nothing with it.
    const max = word.length <= 4 ? 1 : 2;
    let best: string | undefined;
    let bestScore = max + 1;
    const lower = word.toLowerCase();
    for (const c of candidates) {
        // A prefix of a real command is a typo we can name with confidence
        // even when the edit distance is larger ("sess" → "sessions").
        if (c.startsWith(lower) && lower.length >= 3) return c;
        const d = editDistance(lower, c, max);
        if (d < bestScore) {
            bestScore = d;
            best = c;
        }
    }
    return bestScore <= max ? best : undefined;
}

/** "Did you mean" for a command word — aliases included as candidates. */
export function suggestCommand(word: string): string | undefined {
    const names: string[] = [];
    for (const c of COMMANDS) {
        if (c.hidden) continue;
        names.push(c.name, ...(c.aliases ?? []));
    }
    return closest(word, names);
}

/** "Did you mean" for a flag, restricted to what this command accepts. */
export function suggestFlag(name: string, allowed: Set<string>): string | undefined {
    return closest(name, allowed);
}
