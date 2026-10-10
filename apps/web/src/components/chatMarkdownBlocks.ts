/**
 * A message's markdown cut into its top-level blocks — paragraphs, lists,
 * fences, tables — the way oboe.chat and the terminal tokenize a reply with
 * marked. Each block is rendered and memoized on its own source, so while a
 * reply streams only the block being written changes; everything above it
 * keeps its identity and is not parsed or rendered again.
 *
 * Joined back together the blocks are exactly `text`. Anything that would not
 * survive the cut — reference-style links and footnotes, whose definitions
 * live in another block — comes back as one block, as does any text whose
 * tokens do not add up to the original.
 */
import { Lexer } from "marked";

/** `[label]: url` or `[^note]: text` at the start of a line. */
const CROSS_BLOCK_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

export function splitMarkdownBlocks(text: string): string[] {
  if (text.length === 0 || CROSS_BLOCK_DEFINITION.test(text)) return [text];
  let tokens: ReturnType<typeof Lexer.lex>;
  try {
    tokens = Lexer.lex(text, { gfm: true });
  } catch {
    return [text];
  }
  const blocks: string[] = [];
  for (const token of tokens) {
    // Blank lines belong to the block before them, so a block's source only
    // changes when that block itself does.
    if (token.type === "space" && blocks.length > 0) {
      blocks[blocks.length - 1] += token.raw;
      continue;
    }
    blocks.push(token.raw);
  }
  return blocks.join("") === text ? blocks : [text];
}
