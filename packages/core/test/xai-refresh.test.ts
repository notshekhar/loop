import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * xAI rotates refresh tokens and revokes the login when one is used twice.
 * These run the auth module in a child process with its own HOME, the way
 * separate loop processes share one ~/.loop.
 */
function runChild(scenario: string): Record<string, unknown> {
    const home = mkdtempSync(join(tmpdir(), "loop-xai-"));
    try {
        mkdirSync(join(home, ".loop"), { recursive: true });
        writeFileSync(
            join(home, ".loop", "auth.json"),
            JSON.stringify({
                providers: {
                    xai: {
                        mode: "oauth",
                        provider: "xai",
                        xai: { access: "old", refresh: "refresh-0", expires: 0, tokenEndpoint: "https://auth.x.ai/oauth2/token" },
                    },
                },
                active: "xai",
            }),
        );
        const child = Bun.spawnSync(["bun", join(import.meta.dir, "fixtures", "xai-refresh-child.ts"), scenario], {
            env: { ...process.env, HOME: home },
        });
        const out = child.stdout.toString().trim().split("\n").pop() ?? "";
        if (child.exitCode !== 0) throw new Error(child.stderr.toString());
        return JSON.parse(out);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

describe("xAI token refresh", () => {
    test("parallel requests share one refresh", () => {
        const result = runChild("parallel");
        expect(result.refreshCalls).toBe(1);
        expect(new Set(result.tokens as string[]).size).toBe(1);
        expect(result.stored).toBe("refresh-1");
    });

    test("a token another process already rotated is reused, not refreshed again", () => {
        const result = runChild("external");
        expect(result.token).toBe("other-access");
        expect(result.extraRefreshes).toBe(0);
        expect(result.stored).toBe("other-refresh");
    });
});
