import { describe, expect, test } from "bun:test";

import { discoverSourceControl, parseGhAuth, parseVersion } from "../../src/workspace/discovery";

describe("parsing versions", () => {
    test("reads the version out of what the tools actually print", () => {
        expect(parseVersion("git version 2.54.0")).toBe("2.54.0");
        expect(parseVersion("gh version 2.95.0 (2026-06-17)")).toBe("2.95.0");
        // Apple ships git with a vendor suffix.
        expect(parseVersion("git version 2.39.5 (Apple Git-154)")).toBe("2.39.5");
        expect(parseVersion("jj 0.24.0")).toBe("0.24.0");
    });

    test("returns null rather than a wrong guess", () => {
        expect(parseVersion("")).toBeNull();
        expect(parseVersion("command not found")).toBeNull();
    });
});

describe("parsing gh auth status", () => {
    const authed =
        "github.com\n  ✓ Logged in to github.com account notshekhar (keyring)\n" +
        "  - Active account: true\n  - Token: ghp_****\n";

    test("finds the account and host", () => {
        expect(parseGhAuth({ ok: true, stdout: authed, stderr: "" })).toEqual({
            status: "authenticated",
            account: "notshekhar",
            host: "github.com",
            detail: null,
        });
    });

    test("reads it off stderr too", () => {
        // Older gh writes this to stderr; checking only stdout made a signed-in
        // user look logged out.
        expect(parseGhAuth({ ok: true, stdout: "", stderr: authed }).status).toBe("authenticated");
    });

    test("trusts the text over the exit code", () => {
        // gh exits non-zero when ANY configured host is logged out, even if the one
        // that matters is fine.
        expect(parseGhAuth({ ok: false, stdout: authed, stderr: "" }).status).toBe("authenticated");
    });

    test("recognises being logged out and says how to fix it", () => {
        const out = parseGhAuth({
            ok: false,
            stdout: "",
            stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
        });
        expect(out.status).toBe("unauthenticated");
        expect(out.detail).toContain("gh auth login");
    });

    test("says unknown rather than guessing at an unfamiliar answer", () => {
        const out = parseGhAuth({ ok: false, stdout: "", stderr: "dial tcp: lookup failed\n" });
        expect(out.status).toBe("unknown");
        expect(out.detail).toBe("dial tcp: lookup failed");
        expect(out.account).toBeNull();
    });
});

describe("scanning this machine", () => {
    test("reports git, and reports jj as present-but-unsupported", async () => {
        const found = await discoverSourceControl();

        const git = found.versionControlSystems.find((v) => v.kind === "git");
        expect(git?.status).toBe("available");
        expect(git?.implemented).toBe(true);
        expect(git?.version).toMatch(/^\d+\.\d+/);

        // loop has exactly one VCS driver; jj is listed for honesty, not as a
        // capability the UI can switch to.
        const jj = found.versionControlSystems.find((v) => v.kind === "jj");
        expect(jj?.implemented).toBe(false);
    });

    test("lists only providers loop can actually act through", async () => {
        const found = await discoverSourceControl();

        // The PR path shells out to `gh`, so GitHub is the only honest entry —
        // listing GitLab because glab is installed would promise a missing button.
        expect(found.sourceControlProviders.map((p) => p.kind)).toEqual(["github"]);
        const github = found.sourceControlProviders[0];
        if (!github) throw new Error("expected a github entry");
        expect(github.executable).toBe("gh");
        expect(["available", "missing"]).toContain(github.status);
        expect(["authenticated", "unauthenticated", "unknown"]).toContain(github.auth.status);
        // A missing gh must never be reported as signed in.
        if (github.status === "missing") expect(github.auth.status).not.toBe("authenticated");
    });
});
