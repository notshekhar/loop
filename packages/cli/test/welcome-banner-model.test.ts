import { describe, expect, test } from "bun:test";
import type { TUI } from "@notshekhar/loop-tui";
import { WelcomeBanner } from "../src/interactive/components/welcome-banner";
import { initTheme } from "../src/interactive/ui/theme";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("welcome banner model row", () => {
    test("follows a model switched after the banner is on screen", () => {
        initTheme("dark");
        let model = "anthropic/old-model";
        const banner = new WelcomeBanner({ requestRender() {} } as unknown as TUI, {
            name: "x",
            model: () => model,
            session: "unsaved",
            agent: null,
            branch: null,
            cwd: "~/repo",
        });

        expect(plain(banner.render(80))).toContain("anthropic/old-model");

        model = "openai/new-model";
        const after = plain(banner.render(80));
        expect(after).toContain("openai/new-model");
        expect(after).not.toContain("anthropic/old-model");
    });
});
