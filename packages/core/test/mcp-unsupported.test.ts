/**
 * Servers that cannot ever issue loop credentials.
 *
 * Figma's remote MCP server allow-lists which PRODUCTS may connect, matching
 * the client name when a client registers and refusing every other. No local
 * configuration reaches that, so the entry used to be written down happily,
 * the login run, and the same 403 returned every time — reported as an HTTP
 * error wrapping a JSON parse error, with a stack, which reads as a fault in
 * loop rather than an answer about Figma.
 */
import { describe, expect, test } from "bun:test";
import { McpUnsupportedServerError, unsupportedRemoteServer } from "../src/mcp/providers";
import { registrationAdvice } from "../src/mcp/authorize";
import { parseServerConfig } from "../src/rpc/mcp-flows";

describe("recognising a server that will not register us", () => {
    test("matches Figma's remote endpoint and its subdomains", () => {
        expect(unsupportedRemoteServer("https://mcp.figma.com/mcp")).toBeDefined();
        expect(unsupportedRemoteServer("https://figma.com/mcp")).toBeDefined();
        expect(unsupportedRemoteServer("https://api.figma.com/v1/oauth/mcp/register")).toBeDefined();
    });

    test("leaves everything else alone, including Figma's own local server", () => {
        // The local Dev Mode server is the thing that DOES work — refusing it
        // would remove the one route the message recommends.
        expect(unsupportedRemoteServer("http://127.0.0.1:3845/mcp")).toBeUndefined();
        expect(unsupportedRemoteServer("https://mcp.example.com/mcp")).toBeUndefined();
        // Not a substring match: a host that merely contains the name is not it.
        expect(unsupportedRemoteServer("https://figma.com.evil.test/mcp")).toBeUndefined();
        expect(unsupportedRemoteServer("https://notfigma.com/mcp")).toBeUndefined();
    });

    test("a URL that will not parse belongs to no provider", () => {
        expect(unsupportedRemoteServer("not a url")).toBeUndefined();
        expect(unsupportedRemoteServer("")).toBeUndefined();
    });

    test("the reason names the block, the route out, and the seat it needs", () => {
        const reason = unsupportedRemoteServer("https://mcp.figma.com/mcp")!;
        expect(reason).toContain("Figma MCP Catalog");
        expect(reason).toContain("http://127.0.0.1:3845/mcp");
        expect(reason).toContain("Dev or Full seat");
        // Advice that cannot work is worse than none: registering an OAuth app
        // does not help here, so the message must not suggest it.
        expect(reason).not.toContain("clientSecret");
    });
});

describe("advice when a registration is refused", () => {
    test("an allow-listed provider gets its own reason", () => {
        expect(registrationAdvice("https://mcp.figma.com/mcp")).toBe(
            unsupportedRemoteServer("https://mcp.figma.com/mcp"),
        );
    });

    test("everyone else is told to register an OAuth app, which for them works", () => {
        const advice = registrationAdvice("https://mcp.example.com/mcp");
        expect(advice).toContain("clientId");
        expect(advice).not.toContain("Figma");
    });
});

describe("adding one", () => {
    test("is refused rather than written down to fail later", () => {
        expect(() => parseServerConfig({ type: "http", url: "https://mcp.figma.com/mcp" })).toThrow(
            McpUnsupportedServerError,
        );
        // The thrown message is the whole explanation — a caller that prints
        // `err.message` has said everything worth reading.
        try {
            parseServerConfig({ type: "http", url: "https://mcp.figma.com/mcp", auth: "oauth" });
            throw new Error("should have refused");
        } catch (err) {
            expect((err as Error).message).toContain("Figma MCP Catalog");
        }
    });

    test("the local server is still accepted", () => {
        expect(parseServerConfig({ type: "http", url: "http://127.0.0.1:3845/mcp" })).toEqual({
            type: "http",
            url: "http://127.0.0.1:3845/mcp",
        });
    });

    test("a stdio server is never checked — it has no URL to check", () => {
        expect(parseServerConfig({ command: "npx", args: ["figma-developer-mcp"] })).toMatchObject({
            type: "stdio",
            command: "npx",
        });
    });
});
