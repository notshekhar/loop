import { describe, expect, it } from "vite-plus/test";

import { stripReplayedPromptMarks } from "./surface.ts";

const MARK = "\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m";

describe("stripReplayedPromptMarks", () => {
  it("drops zsh's end-of-line mark when it starts a line", () => {
    const replay = `ls\r\nREADME.md\r\n${MARK}${" ".repeat(39)}\r \r\x1b[Jprompt %`;
    expect(stripReplayedPromptMarks(replay)).toBe("ls\r\nREADME.md\r\n\x1b[Jprompt %");
  });

  it("drops it at the very start of the history", () => {
    expect(stripReplayedPromptMarks(`${MARK}${" ".repeat(79)}\r \rprompt %`)).toBe("prompt %");
  });

  it("keeps the mark after partial output, where it means no trailing newline", () => {
    const replay = `printf abc\r\nabc${MARK}${" ".repeat(36)}\r \rprompt %`;
    expect(stripReplayedPromptMarks(replay)).toBe(replay);
  });

  it("leaves a literal percent sign alone", () => {
    const replay = "echo 100%\r\n100%\r\nprompt %";
    expect(stripReplayedPromptMarks(replay)).toBe(replay);
  });
});
