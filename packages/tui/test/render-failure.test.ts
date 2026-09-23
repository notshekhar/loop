import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { type Component } from "../src/tui";
import { TuiAltScreen } from "../src/tui-alt-screen";
import { resetRenderErrorLogForTest } from "../src/render-error-log";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * A component that throws while rendering must cost exactly that frame.
 *
 * It used to cost the whole UI: the throw escaped `doRender`, the process's
 * uncaught-exception handler surfaced it in the chat and asked for a repaint,
 * and the repaint threw again — nothing painted, the chat grew by an error
 * per frame, and typing and scrolling looked dead until a restart.
 */
class Flaky implements Component {
    throwing = false;
    renders = 0;
    text = "hello";
    render(): string[] {
        this.renders++;
        if (this.throwing) throw new Error("boom in render");
        return [this.text];
    }
    invalidate(): void {}
}

let logDir = "";

beforeEach(() => {
    resetRenderErrorLogForTest();
    logDir = mkdtempSync(join(tmpdir(), "loop-render-failure-"));
});

afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

describe("a frame that throws", () => {
    it("does not escape, is logged once, and is reported once", async () => {
        const terminal = new VirtualTerminal(40, 8);
        const tui = new TuiAltScreen(terminal, false, logDir, { mouse: false });
        const component = new Flaky();
        tui.addChild(component);
        const reported: unknown[] = [];
        tui.onRenderError = (error) => reported.push(error);

        tui.start();
        await terminal.waitForRender();

        component.throwing = true;
        // Several frames in a row, each failing the same way.
        for (let i = 0; i < 5; i++) {
            tui.requestRender();
            await tick();
        }
        assert.equal(reported.length, 1, "the same failure is reported once, not per frame");
        const log = readFileSync(join(logDir, "render-error.log"), "utf8");
        assert.equal(log.split("boom in render").length - 1, 1, "and logged once, with its stack");
        assert.ok(log.includes("frame"));

        tui.stop();
    });

    it("never re-requests itself — a failing frame cannot spin", async () => {
        const terminal = new VirtualTerminal(40, 8);
        const tui = new TuiAltScreen(terminal, false, logDir, { mouse: false });
        const component = new Flaky();
        tui.addChild(component);
        // The handler asks for a repaint, as the app's does — the exact move
        // that used to loop forever.
        tui.onRenderError = () => tui.requestRender();

        tui.start();
        await terminal.waitForRender();
        component.throwing = true;
        tui.requestRender();
        await tick();
        const settled = component.renders;
        await tick();
        await tick();
        assert.ok(component.renders - settled <= 1, `frames kept coming: ${component.renders - settled}`);

        tui.stop();
    });

    it("recovers on the next real event once the component stops throwing", async () => {
        const terminal = new VirtualTerminal(40, 8);
        const tui = new TuiAltScreen(terminal, false, logDir, { mouse: false });
        const component = new Flaky();
        tui.addChild(component);
        tui.onRenderError = () => {};

        tui.start();
        await terminal.waitForRender();
        component.throwing = true;
        tui.requestRender();
        await tick();

        component.throwing = false;
        component.text = "back again";
        tui.requestRender();
        await terminal.waitForRender();
        assert.ok(terminal.getViewport().join("\n").includes("back again"));

        tui.stop();
    });
});
