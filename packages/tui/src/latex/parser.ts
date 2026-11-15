/**
 * A recursive-descent reader over one LaTeX math expression, producing
 * Unicode text. Anything it can't render faithfully marks the expression
 * unsupported, so the caller falls back to the source.
 */
import { renderEnvironment, type EnvironmentHost } from "./environments";
import {
    formatFraction,
    formatRoot,
    formatScript,
    NAMED_OPERATOR_END,
    NAMED_OPERATOR_START,
    normalizeOutput,
} from "./format";
import { addLayoutNode, TRAILING_LAYOUT_MARKER_PATTERN, type LayoutNode } from "./layout";
import {
    ACCENTS,
    BLACKBOARD,
    DISPLAY_LIMIT_SYMBOLS,
    IGNORED_COMMANDS,
    LIMIT_OPERATORS,
    NAMED_OPERATORS,
    NEGATED_SYMBOLS,
    NEGATIVE_SPACE,
    NEGATIVE_SPACING_COMMANDS,
    PLAIN_WRAPPERS,
    RELATION_COMMANDS,
    SIZE_COMMANDS,
    SPACING_COMMANDS,
    SYMBOLS,
} from "./symbols";

/** `\{`, `\$` and friends render as the character itself. */
const ESCAPED_CHARACTERS = new Set(["{", "}", "$", "%", "#", "_", "&"]);
const DELIMITER_SIZING = new Set(["left", "middle", "right"]);
/** Roots with a Unicode symbol of their own. */
const ROOT_SYMBOLS = new Map([
    ["2", "√"],
    ["3", "∛"],
    ["4", "∜"],
]);
const BINARY_OPERATOR_COMMANDS = new Set(["cdot", "times"]);

/**
 * Commands whose output depends only on their name — checked first, in this
 * order, before anything that reads arguments.
 */
function fixedCommandOutput(command: string): string | undefined {
    if (command === "\\") return "\n";
    if (SPACING_COMMANDS.has(command)) return " ";
    if (NEGATIVE_SPACING_COMMANDS.has(command)) return NEGATIVE_SPACE;
    if (IGNORED_COMMANDS.has(command)) return "";
    if (ESCAPED_CHARACTERS.has(command)) return command;
    if (command === "|") return "‖";
    return undefined;
}

type ArgumentCommand = (parser: LatexParser, command: string) => string;

/** Commands that read arguments, by name. */
const ARGUMENT_COMMANDS = new Map<string, ArgumentCommand>([
    ...["frac", "dfrac", "tfrac"].map((name) => [name, (p: LatexParser, c: string) => p.parseFraction(c)] as const),
    ["sqrt", (p) => p.parseRoot()],
    ...["boxed", "fbox"].map((name) => [name, (p: LatexParser) => `[${p.parseRequiredArgument().trim()}]`] as const),
    ...["binom", "dbinom", "tbinom"].map(
        (name) =>
            [name, (p: LatexParser) => `(${p.parseRequiredArgument()} choose ${p.parseRequiredArgument()})`] as const,
    ),
]);

/** Commands that read arguments and come after the accent check. */
const LATE_ARGUMENT_COMMANDS = new Map<string, ArgumentCommand>([
    [
        "mathbb",
        (p) => Array.from(p.parseRequiredArgument(), (character) => BLACKBOARD[character] ?? character).join(""),
    ],
    ["operatorname", (p) => p.parseOperatorName()],
    ["mod", () => " mod "],
    ["bmod", () => " mod "],
    ["pmod", (p) => ` (mod ${p.parseRequiredArgument().trim()})`],
    ["pod", (p) => ` (${p.parseRequiredArgument().trim()})`],
    ["overset", (p) => p.parseScriptedBase("sup")],
    ["stackrel", (p) => p.parseScriptedBase("sup")],
    ["underset", (p) => p.parseScriptedBase("sub")],
]);

export class LatexParser implements EnvironmentHost {
    private position = 0;
    private supported = true;
    private stackFractions = true;

    constructor(
        private readonly source: string,
        readonly layoutNodes: LayoutNode[],
        private readonly display: boolean,
    ) {}

    render(): string | undefined {
        const rendered = this.parseSequence();
        if (!this.supported || this.position !== this.source.length) {
            return undefined;
        }
        return normalizeOutput(rendered);
    }

    fail(): void {
        this.supported = false;
    }

    renderNested(source: string, stackFractions = true): string {
        const rendered = new LatexParser(source, this.layoutNodes, this.display && stackFractions).render();
        if (rendered === undefined) {
            this.fail();
            return source;
        }
        return rendered;
    }

    private get current(): string | undefined {
        return this.source[this.position];
    }

    private skipWhile(pattern: RegExp): void {
        while (this.position < this.source.length && pattern.test(this.source[this.position] ?? "")) {
            this.position++;
        }
    }

    private parseSequence(endCharacter?: string): string {
        let result = "";
        while (this.position < this.source.length) {
            const character = this.source[this.position]!;
            if (endCharacter && character === endCharacter) {
                this.position++;
                return result;
            }
            if (character === "}") {
                this.fail();
                return result;
            }
            result = this.parseSequenceItem(character, result);
        }
        if (endCharacter) {
            this.fail();
        }
        return result;
    }

    /** Consume one item at `character` and return `result` with it applied. */
    private parseSequenceItem(character: string, result: string): string {
        if (character === "{") {
            this.position++;
            return result + this.parseSequence("}");
        }
        if (character === "\\") return this.appendCommand(result, this.parseCommand());
        if (character === "^" || character === "_") return this.appendScript(result, character);
        if (/\s/.test(character)) {
            this.skipWhile(/\s/);
            return result + " ";
        }
        this.position++;
        if (character === "=" || character === "<" || character === ">") return `${result.trimEnd()} ${character} `;
        if (character === "&") return result;
        if (character === "~") return result + " ";
        if (character === "." && this.appendToTrailingMatrix(result, character)) return result;
        return result + character;
    }

    /** A negative space pulls the previous item closer, dropping a named operator's spacing. */
    private appendCommand(result: string, command: string): string {
        if (command !== NEGATIVE_SPACE) return result + command;
        const trimmed = result.trimEnd();
        return trimmed.endsWith(NAMED_OPERATOR_END) ? trimmed.slice(0, -NAMED_OPERATOR_END.length) : trimmed;
    }

    /** A script binds to what precedes it — inside a named operator's markers if that is what precedes it. */
    private appendScript(result: string, character: "^" | "_"): string {
        this.position++;
        const base = result.trimEnd();
        const script = formatScript(this.parseRequiredArgument(false), character === "_" ? "sub" : "sup");
        if (base.endsWith(NAMED_OPERATOR_END)) {
            return `${base.slice(0, -NAMED_OPERATOR_END.length)}${script}${NAMED_OPERATOR_END}`;
        }
        return base + script;
    }

    /** Sentence punctuation after a matrix belongs on its last row. */
    private appendToTrailingMatrix(result: string, character: string): boolean {
        const marker = TRAILING_LAYOUT_MARKER_PATTERN.exec(result);
        const node = marker ? this.layoutNodes[Number(marker[1])] : undefined;
        if (node?.type !== "matrix") return false;
        const lastLine = node.lines.length - 1;
        node.lines[lastLine] = `${node.lines[lastLine] ?? ""}${character}`;
        return true;
    }

    private parseCommand(): string {
        this.position++;
        if (this.position >= this.source.length) {
            this.fail();
            return "";
        }
        const first = this.current ?? "";
        if (first === "\n" || first === "\r") {
            // A backslash before a line break is a control space.
            this.position++;
            if (first === "\r" && this.current === "\n") this.position++;
            return " ";
        }
        const command = this.readCommandName(first);
        return (
            fixedCommandOutput(command) ??
            this.parseSymbolCommand(command) ??
            this.parseArgumentCommand(command) ??
            this.unsupportedCommand(command)
        );
    }

    /** A run of letters, or any single other character. */
    private readCommandName(first: string): string {
        if (!/[A-Za-z]/.test(first)) {
            this.position++;
            return first;
        }
        const start = this.position;
        this.skipWhile(/[A-Za-z]/);
        return this.source.slice(start, this.position);
    }

    /** Negation, operators with limits, symbols, named operators and sizing. */
    private parseSymbolCommand(command: string): string | undefined {
        if (command === "not") return this.parseNegation();
        if (LIMIT_OPERATORS.has(command)) return this.parseOperator(command, "bracket", true, true);
        const symbol = SYMBOLS[command];
        if (symbol !== undefined) {
            if (DISPLAY_LIMIT_SYMBOLS.has(command)) return this.parseOperator(symbol, "script", true);
            return BINARY_OPERATOR_COMMANDS.has(command) || RELATION_COMMANDS.has(command) ? ` ${symbol} ` : symbol;
        }
        if (NAMED_OPERATORS.has(command)) return `${NAMED_OPERATOR_START}${command}${NAMED_OPERATOR_END}`;
        if (SIZE_COMMANDS.has(command)) return "";
        if (DELIMITER_SIZING.has(command)) {
            // `\left.` is an invisible delimiter.
            if (this.current === ".") this.position++;
            return "";
        }
        return undefined;
    }

    private parseArgumentCommand(command: string): string | undefined {
        const early = ARGUMENT_COMMANDS.get(command);
        if (early) return early(this, command);
        const accent = ACCENTS[command];
        if (accent !== undefined) {
            const value = this.parseRequiredArgument();
            return Array.from(value).length === 1 ? `${value}${accent}` : `${command}(${value})`;
        }
        const late = LATE_ARGUMENT_COMMANDS.get(command);
        if (late) return late(this, command);
        if (PLAIN_WRAPPERS.has(command)) {
            const value = this.parseRequiredArgument();
            return command.startsWith("text") || command === "mbox" ? value : value.trim();
        }
        if (command === "begin") return this.parseEnvironment();
        return undefined;
    }

    /** `\end` without its `\begin`, or a command we don't know. */
    private unsupportedCommand(command: string): string {
        this.fail();
        return command === "end" ? "" : `\\${command}`;
    }

    private parseNegation(): string {
        const value = this.parseRequiredArgument(false).trim();
        const negated = NEGATED_SYMBOLS[value];
        if (negated !== undefined) return ` ${negated} `;
        const characters = Array.from(value);
        if (characters.length === 0) {
            this.fail();
            return "";
        }
        return ` ${characters[0]}̸${characters.slice(1).join("")} `;
    }

    /** Stacked in display math (unless \tfrac or nested where stacking is off), a/b otherwise. */
    parseFraction(command: string): string {
        const shouldStack = this.display && this.stackFractions && command !== "tfrac";
        const numerator = this.parseRequiredArgument(!shouldStack);
        const denominator = this.parseRequiredArgument(!shouldStack);
        if (!shouldStack) return formatFraction(numerator, denominator);
        return addLayoutNode(this.layoutNodes, {
            type: "fraction",
            numerator: normalizeOutput(numerator),
            denominator: normalizeOutput(denominator),
        });
    }

    parseRoot(): string {
        const degree = this.parseOptionalArgument()?.trim();
        const value = this.parseRequiredArgument();
        const symbol = ROOT_SYMBOLS.get(degree ?? "2");
        if (symbol !== undefined) return formatRoot(value, symbol);
        return `${formatScript(degree!, "sup")}${formatRoot(value)}`;
    }

    parseOperatorName(): string {
        const starred = this.current === "*";
        if (starred) this.position++;
        const operator = normalizeOutput(this.parseRequiredArgument()).trim();
        return this.parseOperator(operator, "bracket", starred, true);
    }

    /** \overset / \underset: the base, with the other argument as a script. */
    parseScriptedBase(kind: "sup" | "sub"): string {
        const script = this.parseRequiredArgument();
        const value = this.parseRequiredArgument().trim();
        return `${value}${formatScript(script, kind)}`;
    }

    private parseOperator(
        operator: string,
        inlineLowerStyle: "bracket" | "script",
        displayLimits: boolean,
        spaced = false,
    ): string {
        const useDisplayLimits = this.readLimitsModifier() ?? displayLimits;
        const { lower, upper } = this.readOperatorScripts();
        if (this.display && useDisplayLimits && (lower !== undefined || upper !== undefined)) {
            return addLayoutNode(this.layoutNodes, { type: "operator", operator, lower, upper });
        }
        let rendered = operator;
        if (lower !== undefined) {
            rendered += inlineLowerStyle === "bracket" ? `[${lower}]` : formatScript(lower, "sub");
        }
        if (upper !== undefined) {
            rendered += formatScript(upper, "sup");
        }
        return spaced ? ` ${rendered} ` : rendered;
    }

    /** Index of the next character that isn't a space or tab, without consuming. */
    private peekPastBlanks(): number {
        let position = this.position;
        while (position < this.source.length && /[ \t]/.test(this.source[position] ?? "")) position++;
        return position;
    }

    /** `\limits` → true, `\nolimits` → false, neither → undefined (and nothing consumed). */
    private readLimitsModifier(): boolean | undefined {
        const position = this.peekPastBlanks();
        const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.source.slice(position));
        if (!modifier) return undefined;
        this.position = position + modifier[0].length;
        return modifier[1] === "limits";
    }

    /** The operator's `_` and `^` scripts, in any order; a repeated one is unsupported. */
    private readOperatorScripts(): { lower?: string; upper?: string } {
        const scripts: { lower?: string; upper?: string } = {};
        for (;;) {
            const position = this.peekPastBlanks();
            const kind = this.source[position];
            if (kind !== "_" && kind !== "^") return scripts;
            this.position = position + 1;
            const value = normalizeOutput(this.parseRequiredArgument(false)).replaceAll(" ", "");
            const slot = kind === "_" ? "lower" : "upper";
            if (scripts[slot] !== undefined) this.fail();
            scripts[slot] = value;
        }
    }

    parseRequiredArgument(stackFractions = true): string {
        const previousStackFractions = this.stackFractions;
        this.stackFractions = previousStackFractions && stackFractions;
        const value = this.parseRequiredArgumentValue();
        this.stackFractions = previousStackFractions;
        return value;
    }

    private parseRequiredArgumentValue(): string {
        this.skipWhile(/\s/);
        if (this.position >= this.source.length) {
            this.fail();
            return "";
        }
        if (this.current === "{") {
            this.position++;
            return this.parseSequence("}");
        }
        if (this.current === "\\") {
            return this.parseCommand();
        }
        const value = this.current ?? "";
        this.position++;
        return value;
    }

    private parseOptionalArgument(): string | undefined {
        this.skipWhile(/[ \t]/);
        if (this.current !== "[") {
            return undefined;
        }
        const end = this.source.indexOf("]", this.position + 1);
        if (end < 0) {
            this.fail();
            return undefined;
        }
        const value = this.source.slice(this.position + 1, end);
        this.position = end + 1;
        return this.renderNested(value);
    }

    /** A `{…}` group's raw source, braces balanced, escapes skipped. */
    private readRawGroup(): string | undefined {
        this.skipWhile(/[ \t]/);
        if (this.current !== "{") {
            this.fail();
            return undefined;
        }
        const start = ++this.position;
        let depth = 1;
        while (this.position < this.source.length) {
            const character = this.source[this.position];
            if (character === "\\") {
                this.position += 2;
                continue;
            }
            if (character === "{") depth++;
            if (character === "}") depth--;
            if (depth === 0) {
                const value = this.source.slice(start, this.position);
                this.position++;
                return value;
            }
            this.position++;
        }
        this.fail();
        return undefined;
    }

    private parseEnvironment(): string {
        const environment = this.readRawGroup();
        if (!environment) {
            return "";
        }
        const endMarker = `\\end{${environment}}`;
        const end = this.source.indexOf(endMarker, this.position);
        if (end < 0) {
            this.fail();
            return "";
        }
        const body = this.source.slice(this.position, end);
        this.position = end + endMarker.length;
        return renderEnvironment(this, environment, body);
    }
}
