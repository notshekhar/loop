/**
 * What the PERSON typed, out of a user message an agent stored.
 *
 * Every agent writes more than the prompt into its user turns: Claude Code's
 * `<system-reminder>` and slash-command echoes, Codex's `<environment_context>`
 * and AGENTS.md dump, Cursor's `<user_info>` and `<timestamp>` around a
 * `<user_query>`. Imported as-is, those turns would bury every prompt under
 * pages of machinery the user never wrote.
 */

/**
 * Blocks an agent mixes INTO a turn the person typed — a reminder above the
 * prompt, a timestamp beside it. Their whole content goes. A turn made of
 * nothing but tag blocks is dropped by the rule in {@link userPrompt}, so this
 * list only needs the blocks that share a turn with real text.
 */
const INJECTED_TAGS = [
    "system-reminder",
    "system_reminder",
    "environment_context",
    "user_info",
    "timestamp",
    "git_status",
    "attached_files",
    "open_and_recently_viewed_files",
];

/** Turns that are only a tool's echo of something, never a prompt (Claude Code's slash-command records). */
const ECHO_PREFIXES = ["<command-name>", "<command-message>", "<local-command-", "Caveat: The messages below"];

function escapeTag(tag: string): string {
    return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const INJECTED = new RegExp(
    `<(${INJECTED_TAGS.map(escapeTag).join("|")})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`,
    "g",
);

/** Codex prefixes a whole AGENTS.md as a user turn that begins with this heading. */
const AGENTS_DUMP = /^# AGENTS\.md instructions for /;

/** One whole `<tag …>…</tag>` block at the start of the text, with the space after it. */
const LEADING_BLOCK = /^<([A-Za-z_][\w -]*?)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/;

/**
 * Whether a turn is nothing but tag blocks — rules, skills, transcripts,
 * tool catalogs. Agents inject dozens of these and invent new ones with each
 * release, so they are recognised by shape rather than by name: a person
 * does not type a message made only of XML blocks.
 */
function onlyTagBlocks(text: string): boolean {
    let rest = text;
    for (let match = LEADING_BLOCK.exec(rest); match; match = LEADING_BLOCK.exec(rest)) {
        rest = rest.slice(match[0].length);
    }
    return rest.length === 0 && text.length > 0;
}

/** The prompt inside an agent's user turn, or "" when the turn holds nothing the user wrote. */
export function userPrompt(raw: string): string {
    const text = raw.trim();
    if (ECHO_PREFIXES.some((p) => text.startsWith(p)) || AGENTS_DUMP.test(text)) return "";
    // Cursor wraps the prompt itself; what is outside the wrapper is context.
    const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
    if (query) return query[1].trim();
    if (onlyTagBlocks(text)) return "";
    return text.replace(INJECTED, "").trim();
}
