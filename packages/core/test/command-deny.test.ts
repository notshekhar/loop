import { describe, expect, test } from "bun:test";
import {
    findDeniedCommand,
    formatApprovalRefusal,
    formatDenyRefusal,
    isCommandAllowed,
    suggestAllowPatterns,
} from "../src/tools/utils/command-deny";

const deny = ["rm", "git commit", "sudo"];

describe("findDeniedCommand", () => {
    test("matches a bare command", () => {
        expect(findDeniedCommand("rm file.txt", deny)).toBe("rm");
    });

    test("matches command + subcommand prefix", () => {
        expect(findDeniedCommand('git commit -m "x"', deny)).toBe("git commit");
    });

    test("does not match a sibling subcommand", () => {
        expect(findDeniedCommand("git status", deny)).toBeNull();
    });

    test("allows a command not on the list", () => {
        expect(findDeniedCommand("ls -la", deny)).toBeNull();
    });

    test("resolves a full path to its basename", () => {
        expect(findDeniedCommand("/bin/rm -rf build", deny)).toBe("rm");
    });

    test("sees past leading env assignments and wrappers", () => {
        expect(findDeniedCommand("FOO=1 sudo rm -rf /tmp/x", deny)).toBe("rm");
    });

    test("catches a denied command later in a pipeline", () => {
        expect(findDeniedCommand("cat list.txt && rm list.txt", deny)).toBe("rm");
    });

    test("catches a denied command inside command substitution", () => {
        expect(findDeniedCommand("echo $(git commit -m hi)", deny)).toBe("git commit");
    });

    test("sees through the rtk token-proxy wrapper", () => {
        expect(findDeniedCommand("rtk git commit -m x", deny)).toBe("git commit");
    });

    test("sees through rtk proxy passthrough", () => {
        expect(findDeniedCommand("rtk proxy git commit", deny)).toBe("git commit");
    });

    test("catches a denied command inside sh -c", () => {
        expect(findDeniedCommand("bash -c 'git commit -m hi'", deny)).toBe("git commit");
        expect(findDeniedCommand('sh -c "rm -rf build"', deny)).toBe("rm");
    });

    test("peels interleaved env-assignments and wrappers", () => {
        expect(findDeniedCommand("env FOO=1 sudo rtk rm x", deny)).toBe("rm");
    });

    test("sees past a wrapper's own options and values", () => {
        expect(findDeniedCommand("timeout 5 git commit -m x", deny)).toBe("git commit");
        expect(findDeniedCommand("nice -n 10 git commit", deny)).toBe("git commit");
        expect(findDeniedCommand("timeout -s KILL 5 rm x", deny)).toBe("rm");
        expect(findDeniedCommand("sudo -u root rm x", deny)).toBe("rm");
    });

    test("an empty denylist allows everything", () => {
        expect(findDeniedCommand("rm -rf /", [])).toBeNull();
    });

    test("tolerates legacy {pattern,reason} object entries from older settings", () => {
        // Cast: persisted JSON may still hold the old object form.
        const legacy = [{ pattern: "rm" }] as unknown as string[];
        expect(findDeniedCommand("rm x", legacy)).toBe("rm");
    });
});

describe("formatDenyRefusal", () => {
    test("names the command, frames it as intentional, forbids workarounds", () => {
        const text = formatDenyRefusal("git commit");
        expect(text).toContain("`git commit` is blocked");
        expect(text).toContain("intentional");
        expect(text).toContain("equivalent");
    });

    test("is short (2-3 lines)", () => {
        expect(formatDenyRefusal("git commit").split("\n").length).toBeLessThanOrEqual(3);
    });

    test("offers asking the user to run it or remove it from the denylist", () => {
        const text = formatDenyRefusal("git commit");
        expect(text).toContain("remove it from their denylist");
    });
});

describe("isCommandAllowed (bashApprove allowlist)", () => {
    const allow = ["ls", "git status", "cat"];

    test("bare command on the list is allowed", () => {
        expect(isCommandAllowed("ls -la src", allow)).toBe(true);
    });

    test("command + subcommand pattern scopes to that subcommand", () => {
        expect(isCommandAllowed("git status -sb", allow)).toBe(true);
        expect(isCommandAllowed("git push origin main", allow)).toBe(false);
    });

    test("every segment of a compound command must be allowed", () => {
        expect(isCommandAllowed("ls && cat file.txt", allow)).toBe(true);
        expect(isCommandAllowed("ls && rm -rf /", allow)).toBe(false);
        expect(isCommandAllowed("cat $(rm -rf /)", allow)).toBe(false);
    });

    test("wrappers cannot smuggle an unlisted command", () => {
        expect(isCommandAllowed("sudo rm x", allow)).toBe(false);
        expect(isCommandAllowed("env FOO=1 ls", allow)).toBe(true);
    });

    test("fails closed: empty allowlist and empty command", () => {
        expect(isCommandAllowed("ls", [])).toBe(false);
        expect(isCommandAllowed("   ", allow)).toBe(false);
    });

    test("tolerates legacy {pattern} object entries", () => {
        const legacy = [{ pattern: "ls" }] as unknown as string[];
        expect(isCommandAllowed("ls", legacy)).toBe(true);
    });
});

describe("suggestAllowPatterns", () => {
    test("subcommand tools store command + subcommand", () => {
        expect(suggestAllowPatterns("git status -sb")).toEqual(["git status"]);
        expect(suggestAllowPatterns("npm install --save-dev x")).toEqual(["npm install"]);
    });

    test("plain tools store just the command name", () => {
        expect(suggestAllowPatterns("ls -la src")).toEqual(["ls"]);
        expect(suggestAllowPatterns("cat file.txt")).toEqual(["cat"]);
    });

    test("a flag after a subcommand tool is not treated as a subcommand", () => {
        expect(suggestAllowPatterns("git --version")).toEqual(["git"]);
    });

    test("compound commands produce one pattern per segment, deduped", () => {
        expect(suggestAllowPatterns("ls && ls -la | grep foo")).toEqual(["ls", "grep"]);
    });

    test("wrappers are peeled before suggesting", () => {
        expect(suggestAllowPatterns("sudo git status")).toEqual(["git status"]);
    });
});

describe("formatApprovalRefusal", () => {
    test("names the command, frames it as this-time decision, forbids workarounds", () => {
        const text = formatApprovalRefusal("rm -rf build");
        expect(text).toContain("`rm -rf build`");
        expect(text).toContain("declined");
        expect(text).toContain("equivalent");
    });

    test("truncates long single-line commands and uses only the first line", () => {
        const long = `${"x".repeat(200)}\nsecond line`;
        const text = formatApprovalRefusal(long);
        expect(text).not.toContain("second line");
        expect(text).toContain("…");
    });
});
