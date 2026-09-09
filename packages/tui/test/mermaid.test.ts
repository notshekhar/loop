import assert from "node:assert";
import { describe, it } from "bun:test";
import { Markdown } from "../src/components/markdown";
import { renderMermaid } from "../src/mermaid";
import { visibleWidth } from "../src/utils";
import { defaultMarkdownTheme } from "./test-themes";

const draw = (source: string, width = 80): string[] => {
    const lines = renderMermaid(source, { width });
    assert.ok(lines, `expected ${source.split("\n")[0]} to render`);
    return lines;
};

/** The row a piece of text lands on, or -1. */
const rowOf = (lines: string[], needle: string) => lines.findIndex((line) => line.includes(needle));

describe("mermaid", () => {
    describe("flowchart", () => {
        it("draws nodes as boxes with their labels", () => {
            const lines = draw("flowchart TD\n    A[Start] --> B[Finish]");
            assert.ok(lines.some((line) => line.includes("Start")));
            assert.ok(lines.some((line) => line.includes("Finish")));
            assert.ok(lines.some((line) => line.includes("┌") && line.includes("┐")));
            assert.ok(rowOf(lines, "Start") < rowOf(lines, "Finish"), "TD puts the source above the target");
        });

        it("points the arrowhead the way the edge flows", () => {
            assert.ok(draw("flowchart TD\n    A[a] --> B[b]").some((line) => line.includes("v")));
            assert.ok(draw("flowchart BT\n    A[a] --> B[b]").some((line) => line.includes("^")));
            assert.ok(draw("flowchart LR\n    A[a] --> B[b]").some((line) => line.includes(">")));
            assert.ok(draw("flowchart RL\n    A[a] --> B[b]").some((line) => line.includes("<")));
        });

        it("leaves an open link without a head", () => {
            const lines = draw("flowchart TD\n    A[a] --- B[b]");
            assert.ok(!lines.some((line) => line.includes("v")));
        });

        it("lays LR out across the page", () => {
            const lines = draw("flowchart LR\n    A[Fetch] --> B[Parse] --> C[Store]");
            const row = rowOf(lines, "Fetch");
            assert.ok(row >= 0);
            assert.ok(lines[row]!.includes("Parse") && lines[row]!.includes("Store"), "a chain stays on one row");
        });

        it("renders every spelling of an edge label", () => {
            for (const source of [
                "flowchart TD\n    A[a] -->|yes| B[b]",
                "flowchart TD\n    A[a] -- yes --> B[b]",
                "flowchart TD\n    A[a] -. yes .-> B[b]",
                "flowchart TD\n    A[a] == yes ==> B[b]",
            ]) {
                assert.ok(
                    draw(source).some((line) => line.includes("yes")),
                    source,
                );
            }
        });

        it("keeps two labels off the same cells", () => {
            const lines = draw("flowchart TD\n    A{go?} -->|yes| B[b]\n    A -->|no| C[c]");
            assert.ok(rowOf(lines, "yes") >= 0);
            assert.ok(rowOf(lines, "no") >= 0);
            assert.notStrictEqual(rowOf(lines, "yes"), rowOf(lines, "no"));
        });

        it("chains and shapes parse together", () => {
            const lines = draw("flowchart TD\n    A([start]) --> B{{choice}} --> C((stop))");
            assert.ok(lines.some((line) => line.includes("start")));
            assert.ok(lines.some((line) => line.includes("choice")));
            assert.ok(lines.some((line) => line.includes("stop")));
            assert.ok(
                lines.some((line) => line.includes("╭")),
                "a round shape keeps rounded corners",
            );
        });

        it("splits a label on <br/>", () => {
            const lines = draw('flowchart TD\n    A["First<br/>Second"] --> B[b]');
            assert.strictEqual(rowOf(lines, "First") + 1, rowOf(lines, "Second"));
        });

        it("routes an edge that skips a rank around the boxes between", () => {
            const lines = draw("flowchart TD\n    A[One] --> B[Two] --> C[Three]\n    A --> C");
            const row = rowOf(lines, "Two");
            // The long edge has to survive the row the intervening box sits on.
            assert.ok(lines[row]!.includes("│"), "the skipping edge is still drawn beside the box");
            assert.ok(lines[row]!.includes("Two"), "and the box it skips is intact");
        });

        it("lays out a cycle instead of hanging", () => {
            const lines = draw("flowchart TD\n    A[Plan] --> B[Build] --> C[Test]\n    C --> A\n    C --> D[Ship]");
            assert.ok(lines.some((line) => line.includes("Ship")));
            assert.ok(
                lines.some((line) => line.includes("^")),
                "the back edge points back up",
            );
        });

        it("keeps a chart with a back edge inside its own width", () => {
            // The neighbour maps are keyed by rank; keyed by edge direction, the
            // retry edge here walked the chart out to 198 columns and was then
            // declined for width.
            const lines = draw(
                [
                    "flowchart TD",
                    "    A[Request] --> B{2xx?}",
                    "    B -->|yes| C[Return]",
                    "    B -->|no| D{Retries left?}",
                    "    D -->|yes| E[Back off] --> A",
                    "    D -->|no| F[Fail]",
                ].join("\n"),
                78,
            );
            for (const line of lines) assert.ok(visibleWidth(line) <= 50, `unexpectedly wide: ${line.length}`);
            assert.ok(lines.some((line) => line.includes("Back off")));
        });

        it("survives a self loop", () => {
            const lines = draw("flowchart TD\n    A[Retry] --> A\n    A --> B[Done]");
            assert.ok(lines.some((line) => line.includes("Retry")));
            assert.ok(lines.some((line) => line.includes("Done")));
        });

        it("ignores styling directives and subgraph wrappers", () => {
            const lines = draw(
                [
                    "flowchart TD",
                    "    %% a comment",
                    "    classDef big fill:#f9f",
                    "    subgraph one",
                    "    A[Inside] --> B[Also]",
                    "    end",
                    "    class A big",
                ].join("\n"),
            );
            assert.ok(lines.some((line) => line.includes("Inside")));
            assert.ok(lines.some((line) => line.includes("Also")));
            assert.ok(!lines.some((line) => line.includes("classDef")));
        });
    });

    describe("sequence", () => {
        const source = [
            "sequenceDiagram",
            "    participant C as Client",
            "    participant S as Server",
            "    C->>S: request",
            "    S-->>C: reply",
            "    Note over C,S: cached",
        ].join("\n");

        it("draws a lifeline per participant", () => {
            const lines = draw(source);
            assert.ok(lines[1]!.includes("Client") && lines[1]!.includes("Server"));
            assert.ok(lines.some((line) => line.includes("request")));
            assert.ok(lines.some((line) => line.includes("reply")));
        });

        it("distinguishes a dashed reply from a solid call", () => {
            const lines = draw(source);
            const request = lines[rowOf(lines, "request") + 1]!;
            const reply = lines[rowOf(lines, "reply") + 1]!;
            assert.ok(request.includes("─"), "a solid call uses an unbroken rule");
            assert.ok(reply.includes("- "), "a dashed reply does not");
        });

        it("covers the lifelines with a note rather than crossing them", () => {
            const lines = draw(source);
            const row = rowOf(lines, "cached");
            assert.ok(row > 0);
            assert.ok(!lines[row - 1]!.includes("┼"), "the note's border sits over the lifelines");
        });

        it("infers participants that were never declared", () => {
            const lines = draw("sequenceDiagram\n    Alice->>Bob: hi");
            assert.ok(lines[1]!.includes("Alice") && lines[1]!.includes("Bob"));
        });

        it("frames a loop and an alt", () => {
            const lines = draw(
                ["sequenceDiagram", "    A->>B: go", "    loop twice", "    A->>B: again", "    end"].join("\n"),
            );
            assert.ok(lines.some((line) => line.includes("loop twice")));
        });

        it("spends rows on long labels instead of widening the columns", () => {
            // Eight participants with prose labels laid out at 279 columns while
            // every label demanded the full span between its two lifelines.
            const source = [
                "sequenceDiagram",
                "    actor U as User",
                "    participant CLI as cli / tui",
                "    participant S as session tree",
                "    participant A as agent loop (core)",
                "    participant P as providers · catalog",
                "    participant M as model (AI SDK)",
                "    participant T as tools",
                "    participant B as sandbox",
                "    U->>CLI: prompt (or /cmd, /model)",
                "    CLI->>S: append node to session tree",
                "    A->>T: dispatch",
                "    T->>B: bash to Seatbelt/bwrap isolation",
                "    B-->>T: stdout / files / exit",
            ].join("\n");
            const lines = draw(source, 160);
            for (const line of lines) assert.ok(visibleWidth(line) <= 160, JSON.stringify(line));
            assert.ok(lines.some((line) => line.includes("sandbox")));
        });

        it("bends a self call back into its own lifeline", () => {
            const lines = draw("sequenceDiagram\n    A->>A: think");
            assert.ok(lines.some((line) => line.includes("think")));
            assert.ok(lines.some((line) => line.includes("<")));
        });
    });

    describe("declining", () => {
        const declines = (source: string, width = 80) =>
            assert.strictEqual(renderMermaid(source, { width }), undefined, source.split("\n")[0]);

        it("passes on diagram kinds it cannot draw", () => {
            declines('pie title Pets\n    "Dogs" : 386');
            declines("gantt\n    title A");
            declines("classDiagram\n    Animal <|-- Duck");
            declines("erDiagram\n    A ||--o{ B : has");
        });

        it("wraps and turns a chart rather than giving up on the width", () => {
            const wide = "flowchart LR\n    A[aaaaaaaaaaaaaaaa] --> B[bbbbbbbbbbbbbbbb] --> C[cccccccccccccccc]";
            for (const width of [120, 40]) {
                const lines = renderMermaid(wide, { width });
                assert.ok(lines, `expected a fit at ${width}`);
                for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
            }
        });

        it("turns a fan-out sideways instead of breaking its words", () => {
            // Six children with long labels is far past any terminal as TD, and
            // fits as LR — the words must survive that.
            const source = [
                "flowchart TD",
                "    Hub[dispatcher] --> A[first consumer]",
                "    Hub --> B[second consumer]",
                "    Hub --> C[third consumer]",
                "    Hub --> D[fourth consumer]",
                "    Hub --> E[fifth consumer]",
                "    Hub --> F[sixth consumer]",
            ].join("\n");
            const lines = draw(source, 100);
            for (const line of lines) assert.ok(visibleWidth(line) <= 100, JSON.stringify(line));
            assert.ok(
                lines.some((line) => line.includes("dispatcher")),
                "the label is intact rather than split",
            );
        });

        it("passes on malformed or empty sources", () => {
            declines("flowchart TD\n    ((((");
            declines("");
            declines("just some prose");
            declines("sequenceDiagram");
        });

        it("never draws past the width it was given", () => {
            const lines = draw("flowchart TD\n    A[Load config] --> B{Valid?}\n    B -->|yes| C[Run]", 60);
            for (const line of lines) assert.ok(visibleWidth(line) <= 60, JSON.stringify(line));
        });
    });

    describe("styling", () => {
        it("colours structure and prose through the supplied style", () => {
            const lines = renderMermaid("flowchart TD\n    A[Start] --> B[End]", {
                width: 80,
                style: { border: (text) => `<b>${text}</b>`, label: (text) => `<l>${text}</l>` },
            });
            assert.ok(lines);
            assert.ok(lines.some((line) => line.includes("<b>")));
            assert.ok(lines.some((line) => line.includes("<l>Start</l>")));
        });
    });

    describe("markdown integration", () => {
        const fence = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``;

        it("replaces a mermaid block with the diagram", () => {
            const md = new Markdown(fence("flowchart TD\n    A[Start] --> B[End]"), 0, 0, defaultMarkdownTheme);
            const lines = md.render(60);
            assert.ok(lines.some((line) => line.includes("Start")));
            assert.ok(!lines.some((line) => line.includes("```")), "the fence itself is gone");
        });

        it("leaves other languages alone", () => {
            const md = new Markdown("```ts\nconst a = 1;\n```", 0, 0, defaultMarkdownTheme);
            assert.ok(md.render(60).some((line) => line.includes("```")));
        });

        it("draws the diagram as its lines arrive, before the fence closes", () => {
            const doc = "```mermaid\nflowchart TD\n    A[Start] --> B[Middle]\n    B --> C[End]\n";
            const md = new Markdown(doc, 0, 0, defaultMarkdownTheme);
            md.setStreaming(true);
            const lines = md.render(70);
            assert.ok(
                lines.some((line) => line.includes("Start")),
                "a settled line is already drawn",
            );
            assert.ok(!lines.some((line) => line.includes("```")), "and not left as source");
        });

        it("holds back the line still being typed", () => {
            // `A[Requ` parses as a bare node, so drawing it would flicker the
            // box through its own label one character at a time.
            const doc = "```mermaid\nflowchart TD\n    A[Start] --> B[Middle]\n    B --> C[Endpo";
            const md = new Markdown(doc, 0, 0, defaultMarkdownTheme);
            md.setStreaming(true);
            const lines = md.render(70);
            assert.ok(
                lines.some((line) => line.includes("Middle")),
                "the settled lines are drawn",
            );
            assert.ok(!lines.some((line) => line.includes("Endpo")), "the unfinished line waits for its newline");
        });

        it("shows the source until a whole line has arrived", () => {
            const md = new Markdown("```mermaid\nflowchart TD", 0, 0, defaultMarkdownTheme);
            md.setStreaming(true);
            assert.ok(
                md.render(60).some((line) => line.includes("flowchart TD")),
                "nothing is settled yet, so the source stays readable",
            );
        });

        it("draws the diagram once the fence closes", () => {
            const md = new Markdown("```mermaid\nflowchart TD\n    A[Start] --> B[End]", 0, 0, defaultMarkdownTheme);
            md.setStreaming(true);
            md.render(60);
            md.setText("```mermaid\nflowchart TD\n    A[Start] --> B[End]\n```");
            md.setStreaming(false);
            const lines = md.render(60);
            assert.ok(lines.some((line) => line.includes("┌")));
        });

        it("falls back to the source when renderMermaid is off", () => {
            const md = new Markdown(
                fence("flowchart TD\n    A[Start] --> B[End]"),
                0,
                0,
                defaultMarkdownTheme,
                undefined,
                {
                    renderMermaid: false,
                },
            );
            const lines = md.render(60);
            assert.ok(lines.some((line) => line.includes("flowchart TD")));
        });

        it("falls back to the source for a diagram it cannot draw", () => {
            const md = new Markdown(fence('pie title Pets\n    "Dogs" : 386'), 0, 0, defaultMarkdownTheme);
            assert.ok(md.render(60).some((line) => line.includes("pie title Pets")));
        });
    });
});
