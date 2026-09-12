/**
 * Shell syntax highlighting for the command shown on a bash tool row.
 *
 * A transcript's bash rows are the one place loop prints something the user
 * would normally read in a coloured shell, and they were printed as one flat
 * grey run — so a pipeline of four stages, a quoted path with a space in it,
 * and a stray `&&` all looked the same. Everything else loop shows is
 * highlighted (a read's file, a diff, a fenced block); the command was not.
 *
 * Not highlight.js. Its bash grammar colours shell BUILT-INS and keywords and
 * leaves the command name alone, so `echo` lights up and `git` does not, which
 * is backwards for a row whose whole subject is which program ran. This follows
 * what an interactive shell highlights instead: the command at the head of each
 * pipeline segment, its quoting, its variables, its operators and redirections.
 *
 * Colour comes from the same `syntax*` theme slots the code highlighter uses,
 * so it repaints with the palette and needs no per-theme work. Everything not
 * recognised keeps the caller's base slot, which is what the whole summary used
 * to be — highlighting adds emphasis here, it does not add a second palette.
 */
import { theme, type Theme } from "./theme";

type Slot = Parameters<Theme["fg"]>[0];

/** Words that put the parser back at the head of a command. */
const COMMAND_BREAK = new Set(["|", "||", "&&", ";", "&", "(", ")", "{", "}", "|&", ";;", ";&", ";;&"]);

/**
 * Shell keywords — grammar rather than programs, so they take the keyword slot
 * even though they sit where a command name would.
 *
 * Only recognised AT a command position. `done` and `in` are ordinary words
 * everywhere else, and `echo done` should not paint its argument as the end of
 * a loop that was never opened.
 */
const KEYWORDS = new Set([
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "function",
    "select",
    "time",
    "coproc",
    "!",
]);

/** Keywords after which the next word names a variable, not a command. */
const BINDS_VARIABLE = new Set(["for", "select"]);

/** Keywords after which the next word is a subject, not a command. */
const TAKES_SUBJECT = new Set(["case"]);

/** Operators worth their own colour, longest first so `&&` beats `&`. */
const OPERATORS = ["&&", "||", "|&", ";;&", ";;", ";&", "|", ";", "&", "(", ")"];
const REDIRECTION = /^(?:\d+)?(?:<<<|<<-|>>|<<|>&|<&|<>|>\||>|<)|^&>>?/;

interface Cursor {
    readonly text: string;
    index: number;
}

function startsWith(cur: Cursor, token: string): boolean {
    return cur.text.startsWith(token, cur.index);
}

/**
 * Read a quoted run, including its closing quote when there is one. An
 * unterminated quote — which a truncated first line often has — runs to the end
 * rather than falling back to per-character colouring.
 */
function readQuoted(cur: Cursor, quote: string): string {
    const start = cur.index;
    cur.index++; // opening quote
    while (cur.index < cur.text.length) {
        const ch = cur.text[cur.index];
        if (ch === "\\" && quote !== "'") {
            cur.index += 2; // an escape inside "" or `` hides the next char
            continue;
        }
        cur.index++;
        if (ch === quote) break;
    }
    return cur.text.slice(start, cur.index);
}

/** Read `$NAME`, `${...}` or `$(...)` — the `$` and what belongs to it. */
function readVariable(cur: Cursor): string {
    const start = cur.index;
    cur.index++; // $
    const next = cur.text[cur.index];
    if (next === "{" || next === "(") {
        const close = next === "{" ? "}" : ")";
        let depth = 1;
        cur.index++;
        while (cur.index < cur.text.length && depth > 0) {
            const ch = cur.text[cur.index++];
            if (ch === next) depth++;
            else if (ch === close) depth--;
        }
    } else {
        while (cur.index < cur.text.length && /[A-Za-z0-9_]/.test(cur.text[cur.index])) cur.index++;
    }
    return cur.text.slice(start, cur.index);
}

/** Quotes and expansions are parts of a word, not separate arguments. */
function readWord(cur: Cursor): { text: string; slot?: Slot }[] {
    const parts: { text: string; slot?: Slot }[] = [];
    while (cur.index < cur.text.length && !/[\s|;&<>()]/.test(cur.text[cur.index])) {
        const ch = cur.text[cur.index];
        if (ch === "'" || ch === '"' || ch === "`") {
            parts.push({ text: readQuoted(cur, ch), slot: "syntaxString" });
        } else if (ch === "$") {
            parts.push({ text: readVariable(cur), slot: "syntaxVariable" });
        } else {
            const start = cur.index;
            do {
                // An escaped separator, space or quote is literal word content.
                cur.index += cur.text[cur.index] === "\\" ? Math.min(2, cur.text.length - cur.index) : 1;
            } while (cur.index < cur.text.length && !/[\s'"`$|;&<>()]/.test(cur.text[cur.index]));
            parts.push({ text: cur.text.slice(start, cur.index) });
        }
    }
    return parts;
}

/**
 * `command` for a single-line shell command, coloured for a terminal row.
 *
 * `base` is the slot everything unrecognised keeps. Input must be plain text:
 * a summary that already carries escapes (an extension's, say) is returned
 * untouched by the caller rather than re-coloured here.
 */
export function highlightShellCommand(command: string, base: Slot = "muted"): string {
    const cur: Cursor = { text: command, index: 0 };
    let out = "";
    // True at the head of a command — the position where a word is the program
    // being run rather than one of its arguments.
    let atCommand = true;
    // `for x` / `select x`: the word after the keyword binds a name.
    let bindingVariable = false;
    // ...and the `in` after that name is the keyword, not an argument.
    let expectingIn = false;
    let redirectTarget = false;
    const paint = (slot: Slot, text: string): void => {
        out += theme.fg(slot, text);
    };

    while (cur.index < cur.text.length) {
        const ch = cur.text[cur.index];

        if (/\s/.test(ch)) {
            const start = cur.index;
            while (cur.index < cur.text.length && /\s/.test(cur.text[cur.index])) cur.index++;
            const whitespace = cur.text.slice(start, cur.index);
            out += whitespace;
            if (whitespace.includes("\n")) {
                atCommand = true;
                bindingVariable = false;
                expectingIn = false;
                redirectTarget = false;
            }
            continue;
        }

        // A `#` that opens a word is a comment to end of line.
        if (ch === "#") {
            const end = cur.text.indexOf("\n", cur.index);
            paint("syntaxComment", cur.text.slice(cur.index, end < 0 ? cur.text.length : end));
            cur.index = end < 0 ? cur.text.length : end;
            continue;
        }

        if (startsWith(cur, "\\\n")) {
            out += "\\\n";
            cur.index += 2;
            continue;
        }

        const redirect = cur.text.slice(cur.index).match(REDIRECTION)?.[0];
        if (redirect) {
            cur.index += redirect.length;
            paint("syntaxOperator", redirect);
            redirectTarget = true;
            continue;
        }

        const op = OPERATORS.find((candidate) => startsWith(cur, candidate));
        if (op) {
            cur.index += op.length;
            paint("syntaxOperator", op);
            // After a pipe or a separator the next word runs a program again.
            if (COMMAND_BREAK.has(op)) {
                atCommand = true;
                bindingVariable = false;
                expectingIn = false;
                redirectTarget = false;
            }
            continue;
        }

        const parts = readWord(cur);
        const word = parts.map((part) => part.text).join("");
        let slot: Slot = base;
        if (redirectTarget) {
            redirectTarget = false;
        } else if (bindingVariable) {
            // `for f` — the loop's own name, which is a variable and not a
            // program however much it sits where one would.
            slot = "syntaxVariable";
            bindingVariable = false;
            expectingIn = true;
            atCommand = false;
        } else if (expectingIn && word === "in") {
            slot = "syntaxKeyword";
            expectingIn = false;
            atCommand = false; // what follows a loop's `in` is values
        } else if (atCommand && KEYWORDS.has(word)) {
            slot = "syntaxKeyword";
            bindingVariable = BINDS_VARIABLE.has(word);
            atCommand = !bindingVariable && !TAKES_SUBJECT.has(word);
        } else if (atCommand) {
            // The program being run. An assignment prefix (`FOO=bar cmd`) is
            // not the program, so the next word still gets the slot.
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) slot = "syntaxVariable";
            else {
                slot = "syntaxFunction";
                atCommand = false;
            }
        } else if (word.startsWith("-")) {
            // Flags recede rather than shout: in a long command they are the
            // part you skim past to find the paths and the pipeline.
            slot = "dim";
        } else if (/^-?\d+(\.\d+)?$/.test(word)) {
            slot = "syntaxNumber";
        }
        for (const part of parts) paint(part.slot ?? slot, part.text);
    }
    return out;
}
