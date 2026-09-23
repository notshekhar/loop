import { beforeEach, describe, expect, test } from "bun:test";
import { Container } from "@notshekhar/loop-tui";

process.env.COLORTERM = "truecolor";

import { AssistantMessageComponent, type AssistantMessageLike } from "../src/interactive/ui/messages";
import { initTheme } from "../src/interactive/ui/theme";

const W = 80;

beforeEach(() => {
    initTheme("night");
});

/** The thinking/response blocks an assistant message is currently made of —
 * the mode's own spacers are not part of what this is about. */
function blocksOf(comp: AssistantMessageComponent): unknown[] {
    return (comp.children[0] as Container).children.filter((c) => "blockKind" in c);
}

function message(content: AssistantMessageLike["content"]): AssistantMessageLike {
    return { content, stopReason: "stop" };
}

describe("assistant blocks survive a streaming delta", () => {
    // Rebuilding them meant a fresh Markdown per block per delta, so every
    // finished block above the cursor was re-lexed on every token.
    test("a finished thinking block is the same component after a text delta", () => {
        const comp = new AssistantMessageComponent();
        const content: AssistantMessageLike["content"] = [
            { type: "thinking", thinking: "Long deliberation. ".repeat(50) },
            { type: "text", text: "Answer so far" },
        ];
        comp.updateContent(message(content));
        const before = blocksOf(comp);

        content[1] = { type: "text", text: "Answer so far, plus more" };
        comp.updateContent(message(content));
        const after = blocksOf(comp);

        expect(after.length).toBe(before.length);
        expect(after[0]).toBe(before[0]); // the thinking block, untouched
        expect(after[1]).toBe(before[1]); // and the growing text block itself
    });

    test("a new content block still gets a new component", () => {
        const comp = new AssistantMessageComponent();
        const content: AssistantMessageLike["content"] = [{ type: "text", text: "first" }];
        comp.updateContent(message(content));
        const first = blocksOf(comp)[0];

        content.push({ type: "thinking", thinking: "then a thought" });
        comp.updateContent(message(content));
        const blocks = blocksOf(comp);
        expect(blocks[0]).toBe(first);
        expect(blocks.length).toBe(2);
    });

    test("a reused block renders exactly what a freshly built one does", () => {
        const grown: AssistantMessageLike["content"] = [
            { type: "thinking", thinking: "Considering the options.\n\nThen deciding." },
            { type: "text", text: "# Answer\n\nFirst para.\n\n- a\n- b\n\nClosing para." },
        ];

        const streamed = new AssistantMessageComponent();
        // Stream it in: thinking first, then the text a slice at a time.
        streamed.updateContent(message([grown[0]]));
        streamed.render(W);
        const full = (grown[1] as { text: string }).text;
        for (let i = 1; i <= full.length; i += 7) {
            streamed.updateContent(message([grown[0], { type: "text", text: full.slice(0, i) }]));
            streamed.render(W);
        }
        streamed.updateContent(message(grown));
        streamed.markDone();
        streamed.updateContent(message(grown));

        const fresh = new AssistantMessageComponent(message(grown));
        fresh.markDone();
        fresh.updateContent(message(grown));

        expect(streamed.render(W)).toEqual(fresh.render(W));
    });

    test("content shrinking back (a replay, a new turn) drops the stale blocks", () => {
        const comp = new AssistantMessageComponent();
        comp.updateContent(
            message([
                { type: "text", text: "one" },
                { type: "text", text: "two" },
            ]),
        );
        comp.updateContent(message([{ type: "text", text: "one" }]));
        expect(blocksOf(comp).length).toBe(1);
    });
});
