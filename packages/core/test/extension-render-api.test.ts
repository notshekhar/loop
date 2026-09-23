import { describe, expect, test } from "bun:test";
import type { ExtensionTheme, ToolSummaryContext } from "../src/extensions/api";
import { summarizeLspCall } from "../src/extensions/builtin/lsp/index";

/** A theme that marks what it styled, so assertions can see the calls. */
const markerTheme: ExtensionTheme = {
    name: "test",
    fg: (slot, text) => `<${slot}>${text}</${slot}>`,
    bg: (slot, text) => `<bg:${slot}>${text}</bg:${slot}>`,
    bold: (text) => `<b>${text}</b>`,
    italic: (text) => `<i>${text}</i>`,
    underline: (text) => `<u>${text}</u>`,
};

const ctx = (): ToolSummaryContext => ({
    toolName: "lsp",
    cwd: "/proj",
    theme: markerTheme,
});

describe("lsp renders its own call summary", () => {
    test("a position operation shows operation and file:line:col", () => {
        const out = summarizeLspCall(
            { operation: "goToDefinition", filePath: "/proj/src/main.ts", line: 4, character: 23 },
            ctx(),
        );
        expect(out).toContain("goToDefinition");
        expect(out).toContain("src/main.ts:4:23");
        // The path is shown relative to cwd, not absolute.
        expect(out).not.toContain("/proj/src");
    });

    test("workspaceSymbol shows the query instead of a position", () => {
        expect(
            summarizeLspCall({ operation: "workspaceSymbol", filePath: "/proj/a.ts", query: "greet" }, ctx()),
        ).toContain('"greet"');
        expect(
            summarizeLspCall({ operation: "workspaceSymbol", filePath: "/proj/a.ts", query: "" }, ctx()),
        ).toContain("(all symbols)");
    });

    test("documentSymbol shows just the file", () => {
        const out = summarizeLspCall({ operation: "documentSymbol", filePath: "/proj/src/a.ts" }, ctx());
        expect(out).toContain("src/a.ts");
        expect(out).not.toMatch(/:\d+:\d+/);
    });

    test("colors come from the supplied theme, never hardcoded", () => {
        const out = summarizeLspCall(
            { operation: "hover", filePath: "/proj/a.ts", line: 1, character: 1 },
            ctx(),
        );
        expect(out).toContain("<muted>");
    });

    test("the operation is the bold half of the row", () => {
        // There is one transcript now, so there is one answer: the verb leads
        // the row in bold and the target follows it plain.
        const out = summarizeLspCall({ operation: "hover", filePath: "/proj/a.ts", line: 1, character: 1 }, ctx());
        expect(out).toContain("<b>hover</b>");
    });

    test("garbage arguments still render something, never throw", () => {
        expect(() => summarizeLspCall({}, ctx())).not.toThrow();
        expect(summarizeLspCall({}, ctx())).toContain("lsp");
    });
});
