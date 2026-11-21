import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { KittyImageCache } from "../src/alt-screen/kitty-cache";
import { buildScreenUpdate } from "../src/alt-screen/screen-update";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const HEIGHT = 16;
const FOOTER = ["────────", "> draft", "status line"];

/** Draw `previous`, then apply the update to `next`; returns what the terminal shows and what was sent. */
async function applyUpdate(previous: string[], next: string[]): Promise<{ viewport: string[]; output: string }> {
    const terminal = new VirtualTerminal(WIDTH, HEIGHT);
    const update = (screen: string[], previousScreen: readonly string[]) =>
        buildScreenUpdate({
            screen,
            previousScreen,
            previousSize: { width: WIDTH, height: HEIGHT },
            width: WIDTH,
            height: HEIGHT,
            cursorPos: null,
            showHardwareCursor: false,
            imageProtocol: null,
            kittyCache: new KittyImageCache(),
        }).output;
    terminal.write(update(previous, []));
    const output = update(next, previous);
    terminal.write(output);
    return { viewport: (await terminal.flushAndGetViewport()).map((row) => row.trimEnd()), output };
}

const rowsWritten = (output: string) => (output.match(/\x1b\[\d+;1H/g) ?? []).length;
const transcript = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => `\x1b[36mline ${from + i}\x1b[0m text`);
const plain = (screen: string[]) => screen.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));

describe("alt-screen scroll shift", () => {
    it("scrolls a growing transcript instead of rewriting it", async () => {
        const body = HEIGHT - FOOTER.length;
        const previous = [...transcript(0, body), ...FOOTER];
        const next = [...transcript(2, body), ...FOOTER];

        const { viewport, output } = await applyUpdate(previous, next);

        assert.deepEqual(viewport, plain(next));
        assert.match(output, /\x1b\[1;13r\x1b\[2S/);
        assert.equal(rowsWritten(output), 2, "only the two new transcript rows are written");
    });

    it("scrolls down when the view moves back through the transcript", async () => {
        const body = HEIGHT - FOOTER.length;
        const previous = [...transcript(10, body), ...FOOTER];
        const next = [...transcript(7, body), ...FOOTER];

        const { viewport, output } = await applyUpdate(previous, next);

        assert.deepEqual(viewport, plain(next));
        assert.match(output, /\x1b\[3T/);
        assert.equal(rowsWritten(output), 3);
    });

    it("leaves a frame alone when nothing moved", async () => {
        const previous = [...transcript(0, HEIGHT - 1), "> a"];
        const next = [...transcript(0, HEIGHT - 1), "> ab"];

        const { viewport, output } = await applyUpdate(previous, next);

        assert.deepEqual(viewport, plain(next));
        assert.doesNotMatch(output, /\x1b\[\d+[ST]/);
        assert.equal(rowsWritten(output), 1);
    });

    it("always ends on exactly the next screen", async () => {
        let seed = 7;
        const random = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            return seed % n;
        };
        const words = ["", "", "alpha", "beta", "\x1b[33mgamma\x1b[0m", "delta", "eps"];
        const randomLine = () => `${words[random(words.length)]}${random(3) === 0 ? ` ${random(99)}` : ""}`;

        for (let round = 0; round < 500; round++) {
            const previous = Array.from({ length: HEIGHT }, randomLine);
            const top = random(HEIGHT);
            const bottom = top + random(HEIGHT - top);
            const lines = random(2 * HEIGHT) - HEIGHT;
            const next = previous.map((line, row) => {
                if (row < top || row > bottom) return line;
                const source = row + lines;
                return source >= top && source <= bottom ? previous[source]! : randomLine();
            });
            for (let edits = random(4); edits > 0; edits--) next[random(HEIGHT)] = randomLine();

            const { viewport } = await applyUpdate(previous, next);
            assert.deepEqual(viewport, plain(next), `round ${round}`);
        }
    });
});
