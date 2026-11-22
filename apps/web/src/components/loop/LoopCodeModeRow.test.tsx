import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LoopToolRow } from "./LoopToolRow";
import { formatToolArgs } from "./loopToolSummary";
import { verbGroupLabel } from "./loopVerbGroup";

const SCRIPT = [
  "// tidy the notes",
  'const notes = await tools.read({ path: "notes.txt" });',
  'await tools.write({ path: "out.txt", content: notes.toUpperCase() });',
].join("\n");

const codeRow = () =>
  renderToStaticMarkup(
    <LoopToolRow
      threadRef={null}
      tool={{
        name: "code",
        args: { code: SCRIPT },
        output: "Script completed (2 tool calls).",
        isError: false,
        isPartial: false,
      }}
      workspaceRoot="/repo"
    />,
  );

describe("a Code Mode call", () => {
  it("reads as the script's first real line, skipping comments", () => {
    expect(formatToolArgs("code", { code: SCRIPT }, "/repo")).toBe(
      'const notes = await tools.read({ path: "notes.txt" });',
    );
  });

  it("folds into a run as a script beside the calls it made", () => {
    const { text } = verbGroupLabel([
      { toolName: "code", isError: false, isRunning: false },
      { toolName: "read", isError: false, isRunning: false },
      { toolName: "write", isError: false, isRunning: false },
    ]);
    expect(text).toBe("Ran 1 script, Read 1 file, Edited 1 file");
  });

  it("keeps the script folded away until the row is opened, and can always be opened", () => {
    const html = codeRow();
    expect(html).toContain("Script completed (2 tool calls).");
    // Its calls have rows of their own; the source is detail.
    expect(html).not.toContain("toUpperCase");
    // One line of output would not make a row expandable on its own; the script does.
    expect(html).toContain('aria-expanded="false"');
  });
});
