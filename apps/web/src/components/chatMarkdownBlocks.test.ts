import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownBlocks } from "./chatMarkdownBlocks";

describe("splitMarkdownBlocks", () => {
  it("cuts a reply into its top-level blocks, losing nothing", () => {
    const text =
      "# Plan\n\nFirst a paragraph.\n\n- one\n- two\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks.join("")).toBe(text);
    expect(blocks).toEqual([
      "# Plan\n\n",
      "First a paragraph.\n\n",
      "- one\n- two\n\n",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
      "| a | b |\n|---|---|\n| 1 | 2 |\n",
    ]);
  });

  it("keeps the finished blocks byte-identical while the last one streams", () => {
    const full = "Intro paragraph.\n\n```sh\nls -la\n```\n\nThen the closing words of the reply.";
    const settled = splitMarkdownBlocks(full).slice(0, -1);
    for (let end = full.indexOf("Then") + 1; end <= full.length; end += 3) {
      const blocks = splitMarkdownBlocks(full.slice(0, end));
      expect(blocks.slice(0, -1)).toEqual(settled);
    }
  });

  it("keeps an unclosed fence as one block until it closes", () => {
    const blocks = splitMarkdownBlocks("Look:\n\n```ts\nconst a = 1;\n\nconst b");
    expect(blocks).toEqual(["Look:\n\n", "```ts\nconst a = 1;\n\nconst b"]);
  });

  it("leaves reference links and footnotes whole, since their definitions live elsewhere", () => {
    const text = "See [the docs][d].\n\nMore text.\n\n[d]: https://example.com\n";
    expect(splitMarkdownBlocks(text)).toEqual([text]);
    const footnote = "A claim.[^1]\n\n[^1]: The source.\n";
    expect(splitMarkdownBlocks(footnote)).toEqual([footnote]);
  });

  it("handles empty and whitespace-only text", () => {
    expect(splitMarkdownBlocks("")).toEqual([""]);
    expect(splitMarkdownBlocks("\n\n").join("")).toBe("\n\n");
  });

  it("falls back to one block when the tokens do not add up to the text", () => {
    const crlf = "one\r\n\r\ntwo\r\n";
    expect(splitMarkdownBlocks(crlf).join("")).toBe(crlf);
  });
});
