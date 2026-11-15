import { Marked, Tokenizer, type Tokens } from "marked";
import { LATEX_MARKDOWN_EXTENSIONS } from "./latex-tokens";

/** Strikethrough needs a non-space right after the opening ~~ and right before the closing one. */
const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
    override del(src: string): Tokens.Del | undefined {
        const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
        if (!match) {
            return undefined;
        }

        const text = match[2];
        return {
            type: "del",
            raw: match[0],
            text,
            tokens: this.lexer.inlineTokens(text),
        };
    }
}

export const markdownParser = new Marked();
markdownParser.setOptions({
    tokenizer: new StrictStrikethroughTokenizer(),
});
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });
