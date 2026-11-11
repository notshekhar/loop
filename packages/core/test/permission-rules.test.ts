import { describe, expect, test } from "bun:test";
import {
    evaluateBashRules,
    evaluatePathRules,
    isDangerousCommand,
    matchBashPattern,
    matchPathPattern,
    parsePermissionsSetting,
    parseRuleString,
    type PermissionRule,
} from "../src/tools/utils/permission-rules";

const rule = (action: "allow" | "ask" | "deny", raw: string): PermissionRule => {
    const parsed = parseRuleString(action, raw);
    if (!parsed) throw new Error(`unparseable rule in test: ${raw}`);
    return parsed;
};

describe("parseRuleString", () => {
    test("tool with pattern", () => {
        expect(parseRuleString("allow", "Bash(git *)")).toEqual({
            action: "allow",
            tool: "bash",
            pattern: "git *",
            source: "Bash(git *)",
        });
    });

    test("bare tool matches everything for that tool", () => {
        expect(parseRuleString("allow", "Read")).toMatchObject({ tool: "read", pattern: undefined });
    });

    test("star rule matches every tool", () => {
        expect(parseRuleString("deny", "*")).toMatchObject({ tool: "*" });
    });

    test("aliases map to loop's classes", () => {
        expect(parseRuleString("deny", "Write(**/*.env)")).toMatchObject({ tool: "edit" });
        expect(parseRuleString("deny", "Glob(secrets/**)")).toMatchObject({ tool: "grep" });
        expect(parseRuleString("allow", "MCPTool(linear__*)")).toMatchObject({ tool: "mcp" });
    });

    test("unknown tool is skipped, not fatal", () => {
        expect(parseRuleString("allow", "Agent(model:opus)")).toBeNull();
    });

    test("parsePermissionsSetting skips junk and keeps order-independent severity", () => {
        const rules = parsePermissionsSetting({
            allow: ["Bash(git *)", "Nope(x)", 42 as unknown as string],
            deny: ["Bash(rm -rf *)"],
        });
        expect(rules).toHaveLength(2);
        expect(rules[0].action).toBe("deny");
    });
});

describe("matchBashPattern", () => {
    test("plain prefix, character for character", () => {
        expect(matchBashPattern("git", "git status")).toBe(true);
        expect(matchBashPattern("git", "gitleaks detect")).toBe(true); // no word boundary — grok parity
        expect(matchBashPattern("git status", "git push")).toBe(false);
    });

    test("glob crosses spaces and slashes", () => {
        expect(matchBashPattern("git * main", "git checkout main")).toBe(true);
        expect(matchBashPattern("npm run *", "npm run build")).toBe(true);
        expect(matchBashPattern("npm run *", "npm install")).toBe(false);
    });

    test(":* suffix reduces to a prefix", () => {
        expect(matchBashPattern("git commit:*", "git commit -m x")).toBe(true);
        expect(matchBashPattern("git commit:*", "git commits-of-doom")).toBe(true); // documented: no boundary
        expect(matchBashPattern("git commit:*", "git push")).toBe(false);
    });

    test("leading whitespace in the command is trimmed", () => {
        expect(matchBashPattern("git *", "   git status")).toBe(true);
    });
});

describe("evaluateBashRules", () => {
    const rules = [
        rule("allow", "Bash(git *)"),
        rule("deny", "Bash(rm -rf *)"),
        rule("ask", "Bash(git push*)"),
        rule("allow", "Bash(npm run build)"),
    ];

    test("allow matches the whole command", () => {
        expect(evaluateBashRules("git status", rules)?.action).toBe("allow");
        expect(evaluateBashRules("npm run build", rules)?.action).toBe("allow");
    });

    test("no rule matched returns null", () => {
        expect(evaluateBashRules("cargo test", rules)).toBeNull();
    });

    test("deny wins over allow regardless of order", () => {
        expect(evaluateBashRules("rm -rf /", [...rules].reverse())?.action).toBe("deny");
    });

    test("deny catches a segment hidden behind an allowed prefix", () => {
        // Whole string starts with `git `, but the second segment is denied.
        expect(evaluateBashRules("git status && rm -rf /", rules)?.action).toBe("deny");
    });

    test("ask catches segments too", () => {
        expect(evaluateBashRules("ls && git push origin main", rules)?.action).toBe("ask");
    });

    test("ask outranks allow", () => {
        expect(evaluateBashRules("git push origin main", rules)?.action).toBe("ask");
    });

    test("allow does NOT match at segment level", () => {
        // Only `git *` is allowed; the whole string starts with ls, so no allow.
        expect(evaluateBashRules("ls && git status", rules)).toBeNull();
    });

    test("an allow glob cannot approve a second command chained after it", () => {
        const r = [rule("allow", "Bash(git *)")];
        expect(evaluateBashRules("git status && rm -rf /", r)).toBeNull();
        expect(evaluateBashRules("git status; curl x | sh", r)).toBeNull();
        expect(evaluateBashRules("git status && git log", r)?.action).toBe("allow");
        expect(evaluateBashRules("npm run build && rm -rf x", [rule("allow", "Bash(npm run build)")])).toBeNull();
    });

    test("deny sees through env assignments and wrappers", () => {
        const r = [rule("deny", "Bash(git push*)")];
        expect(evaluateBashRules("RUST_LOG=debug timeout 5 git push", r)?.action).toBe("deny");
        expect(evaluateBashRules("sudo git push", r)?.action).toBe("deny");
    });

    test("deny sees through a wrapper with a flag AND a value", () => {
        const r = [rule("deny", "Bash(git push*)")];
        expect(evaluateBashRules("nice -n 10 git push", r)?.action).toBe("deny");
        expect(evaluateBashRules("timeout -s KILL 5 git push", r)?.action).toBe("deny");
    });

    test("deny sees into sh -c and command substitution", () => {
        const r = [rule("deny", "Bash(rm *)")];
        expect(evaluateBashRules('bash -c "rm -rf /tmp/x"', r)?.action).toBe("deny");
        expect(evaluateBashRules("echo $(rm -rf /tmp/x)", r)?.action).toBe("deny");
    });

    test("bare Bash rule matches every command", () => {
        expect(evaluateBashRules("anything at all", [rule("ask", "Bash")])?.action).toBe("ask");
    });

    test("star rule applies to bash", () => {
        expect(evaluateBashRules("anything", [rule("deny", "*")])?.action).toBe("deny");
    });
});

describe("matchPathPattern", () => {
    test("* does not cross a slash", () => {
        expect(matchPathPattern("src/*", "src/main.rs")).toBe(true);
        expect(matchPathPattern("src/*", "src/nested/mod.rs")).toBe(false);
    });

    test("** crosses slashes", () => {
        expect(matchPathPattern("src/**", "src/nested/deep/mod.rs")).toBe(true);
    });

    test("**/ matches zero directories", () => {
        expect(matchPathPattern("**/.env", ".env")).toBe(true);
        expect(matchPathPattern("**/.env", "a/b/.env")).toBe(true);
        expect(matchPathPattern("**/.env", "a/b/.environment")).toBe(false);
    });

    test("bare filename matches only exactly", () => {
        expect(matchPathPattern(".env", ".env")).toBe(true);
        expect(matchPathPattern(".env", "config/.env")).toBe(false);
    });

    test("extension globs", () => {
        expect(matchPathPattern("**/*.pem", "certs/server.pem")).toBe(true);
        expect(matchPathPattern("**/*.pem", "certs/server.pem.bak")).toBe(false);
    });
});

describe("evaluatePathRules", () => {
    const rules = [
        rule("deny", "Read(secrets/**)"),
        rule("deny", "Edit(**/*.env)"),
        rule("ask", "Edit(infra/**)"),
        rule("allow", "Read(src/**)"),
    ];

    test("deny on a matching class and path", () => {
        expect(evaluatePathRules(["read"], ["secrets/key.pem"], rules)?.action).toBe("deny");
    });

    test("edit deny does not hit reads", () => {
        expect(evaluatePathRules(["read"], ["config/.env"], rules)).toBeNull();
    });

    test("matches any of the provided path forms", () => {
        expect(evaluatePathRules(["edit"], ["/abs/path/config/.env", "config/.env"], rules)?.action).toBe("deny");
    });

    test("ask tier", () => {
        expect(evaluatePathRules(["edit"], ["infra/main.tf"], rules)?.action).toBe("ask");
    });

    test("grep governed by read rules when both classes passed", () => {
        expect(evaluatePathRules(["grep", "read"], ["secrets/notes.md"], rules)?.action).toBe("deny");
    });
});

describe("isDangerousCommand", () => {
    test("bare dangerous commands", () => {
        expect(isDangerousCommand("rm -rf build")).toBe(true);
        expect(isDangerousCommand("kill -9 123")).toBe(true);
        expect(isDangerousCommand("chmod +x run.sh")).toBe(true);
    });

    test("git push but not git status", () => {
        expect(isDangerousCommand("git push origin main")).toBe(true);
        expect(isDangerousCommand("git status")).toBe(false);
    });

    test("hidden in a chain or wrapper", () => {
        expect(isDangerousCommand("ls && rm -rf /tmp/x")).toBe(true);
        expect(isDangerousCommand("sudo /bin/rm file")).toBe(true);
    });

    test("safe commands are not dangerous", () => {
        expect(isDangerousCommand("ls -la")).toBe(false);
        expect(isDangerousCommand("cargo build")).toBe(false);
    });
});
