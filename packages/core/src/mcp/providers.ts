/**
 * Remote MCP servers that will not register a client like loop at all.
 *
 * Most servers that refuse anonymous registration are simply asking you to
 * create an OAuth app first — set `clientId` and you are in. A few instead
 * allow-list which PRODUCTS may connect, matching the client name at
 * registration and refusing every other. No local configuration reaches that:
 * the entry can be written, the login can be run, and the answer is the same
 * 403 every time.
 *
 * Knowing which kind a server is decides whether the user has a move, so it is
 * worth saying up front rather than after a failed login — and worth saying
 * once, in a place both the add path and the login path can read.
 */

export interface UnsupportedProvider {
    /** Hostname of the MCP endpoint (not the authorization server's). */
    readonly host: RegExp;
    /** Why it cannot work, and what does — shown verbatim to the user. */
    readonly reason: string;
}

export const UNSUPPORTED_REMOTE_PROVIDERS: readonly UnsupportedProvider[] = [
    {
        host: /(^|\.)figma\.com$/i,
        reason:
            "Figma's remote MCP server only accepts clients in the Figma MCP Catalog. Its registration endpoint " +
            "matches on client name and refuses every other, so loop cannot obtain credentials for it.\n" +
            "  There is no way around this from here: the `mcp:connect` scope is not offered to self-serve OAuth " +
            "apps, and personal access tokens are not accepted either. Getting a client listed goes through " +
            "Figma's catalog waitlist.\n" +
            "  What does work is Figma's LOCAL server, which needs no auth at all. In the Figma desktop app open " +
            "a design file, press Shift+D for Dev Mode, enable the desktop MCP server in the inspect panel, then:\n" +
            "    mcp add --transport http figma-desktop http://127.0.0.1:3845/mcp\n" +
            "  It needs a Dev or Full seat — a View or Collab seat is capped at 6 tool calls a month.",
    },
];

/**
 * Why this URL cannot be used as a remote MCP server, or undefined when it can.
 * A URL that will not parse belongs to no provider, and is somebody else's
 * error to report.
 */
export function unsupportedRemoteServer(url: string): string | undefined {
    let host: string;
    try {
        host = new URL(url).hostname;
    } catch {
        return undefined;
    }
    return UNSUPPORTED_REMOTE_PROVIDERS.find((p) => p.host.test(host))?.reason;
}

/**
 * A failure the user can act on, carrying only what they need to read.
 *
 * The SDK reports a refused registration as a JSON parse error wrapped in an
 * HTTP error — true, and about four layers below anything anyone can do. This
 * exists so the CLI and the panels can print one paragraph instead of that,
 * and without a stack trace, which turns an answer back into a crash.
 */
export class McpUnsupportedServerError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "McpUnsupportedServerError";
    }
}
