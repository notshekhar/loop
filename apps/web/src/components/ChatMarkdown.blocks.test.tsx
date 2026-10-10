import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import ChatMarkdown from "./ChatMarkdown";

const REPLY = [
  "# Plan",
  "",
  "First a **paragraph** with `src/index.ts` and [a link](https://example.com).",
  "",
  "1. one",
  "2. two",
  "   - nested",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "> a quote",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "Last line.",
].join("\n");

// Generated ids differ between renders, and the whitespace between two block
// elements is not drawn.
const normalize = (html: string) =>
  html.replace(/\b(?:data-)?id="[^"]*"/g, "").replace(/>\s+</g, "><");

describe("ChatMarkdown, rendered block by block", () => {
  it("draws exactly what the whole text rendered in one piece draws", () => {
    const blocks = renderToStaticMarkup(<ChatMarkdown text={REPLY} cwd="/work" />);
    // A task-list handler keeps the text in one piece (its offsets span it).
    const whole = renderToStaticMarkup(
      <ChatMarkdown text={REPLY} cwd="/work" onTaskListChange={() => {}} />,
    );
    expect(normalize(blocks)).toBe(normalize(whole));
  });
});
