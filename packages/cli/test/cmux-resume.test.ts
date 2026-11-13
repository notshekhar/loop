/**
 * The command cmux re-runs to restore a loop pane (cmux-resume.ts). It runs
 * through the pane's shell after a restart, so it must name the same binary,
 * the same model and provider, and survive any characters in the path.
 */
import { describe, expect, test } from "bun:test";
import { resumeArgv, shellCommand, type LoopLaunch } from "../src/interactive/cmux-resume";

const launch = (over: Partial<LoopLaunch>): LoopLaunch => ({
    execPath: "/usr/local/bin/loop",
    argv: ["/usr/local/bin/loop"],
    pid: 1,
    ...over,
});

describe("cmux resume command", () => {
    test("a compiled binary resumes as itself", () => {
        expect(resumeArgv("s1", launch({}))).toEqual(["/usr/local/bin/loop", "--session", "s1"]);
    });

    test("from source, the entry script leads", () => {
        const argv = resumeArgv(
            "s1",
            launch({ execPath: "/opt/bun", argv: ["/opt/bun", "/src/cli.ts"], main: "/src/cli.ts" }),
        );
        expect(argv).toEqual(["/opt/bun", "/src/cli.ts", "--session", "s1"]);
    });

    test("keeps the flags that pick the agent, drops the task", () => {
        const argv = resumeArgv(
            "s1",
            launch({
                argv: ["/usr/local/bin/loop", "--model", "opus", "--provider=anthropic", "-p", "fix it", "--session", "old"],
            }),
        );
        expect(argv).toEqual(["/usr/local/bin/loop", "--session", "s1", "--model", "opus", "--provider=anthropic"]);
    });

    test("quotes what the shell would split or expand", () => {
        expect(shellCommand(["/Apps/My Tools/loop", "--session", "s1"])).toBe("'/Apps/My Tools/loop' --session s1");
        expect(shellCommand(["it's", "$HOME"])).toBe(`'it'\\''s' '$HOME'`);
    });
});
