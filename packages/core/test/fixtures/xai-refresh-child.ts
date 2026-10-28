/**
 * Child process for xai-refresh.test.ts: runs with HOME pointed at a scratch
 * directory, so the real ~/.loop/auth.json is never read or written. Reports
 * what it saw on stdout as one JSON line.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenario = process.argv[2];
const authPath = join(process.env.HOME!, ".loop", "auth.json");
let refreshCalls = 0;
const spent = new Set<string>();

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    refreshCalls++;
    const presented = body.get("refresh_token") ?? "";
    // Rotating refresh tokens: a second use is treated as theft.
    if (spent.has(presented)) return new Response("invalid_grant", { status: 400 });
    spent.add(presented);
    await new Promise((r) => setTimeout(r, 50));
    return new Response(
        JSON.stringify({ access_token: `access-${refreshCalls}`, refresh_token: `refresh-${refreshCalls}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}) as typeof fetch;

const { getAccessToken } = await import("../../src/auth/index");

function readXai() {
    return JSON.parse(readFileSync(authPath, "utf8")).providers.xai.xai;
}

if (scenario === "parallel") {
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => getAccessToken("xai")));
    console.log(JSON.stringify({ tokens, refreshCalls, stored: readXai().refresh }));
} else if (scenario === "external") {
    // Prime the cache with the expired creds, then let "another process"
    // rotate them on disk.
    await getAccessToken("xai").catch(() => {});
    const before = refreshCalls;
    const doc = JSON.parse(readFileSync(authPath, "utf8"));
    doc.providers.xai.xai = { ...doc.providers.xai.xai, access: "other-access", refresh: "other-refresh", expires: Date.now() + 3_600_000 };
    writeFileSync(authPath, JSON.stringify(doc, undefined, "\t"));
    // Our cache now holds access-1 (fresh): force a 401 on it.
    const token = await getAccessToken("xai", { forceRefresh: true, rejected: "access-1" });
    console.log(JSON.stringify({ token, extraRefreshes: refreshCalls - before, stored: readXai().refresh }));
}
