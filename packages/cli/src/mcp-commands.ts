/**
 * `loop mcp …` — manage MCP servers from the command line, in the style of
 * `claude mcp add` / `codex mcp add`. The bulk of the interesting logic (arg →
 * config) lives in ./mcp-add-parse so it can be tested in isolation.
 */
import {
    addProjectServer,
    addServer,
    authorizeServer,
    clearMcpAuth,
    getGlobalServers,
    getProjectServers,
    isHttpServer,
    loadMcpServers,
    McpUnsupportedServerError,
    projectServersPath,
    redactServerConfig,
    removeProjectServer,
    removeServer,
    unsupportedRemoteServer,
    setProjectServerEnabled,
    setServerEnabled,
    type McpServerConfig,
    CONFIG_DIR_NAME,
    PRODUCT_NAME,
} from "@notshekhar/loop-core";
import { buildAddConfig, firstPositional, positionals, scopeFlag, McpUsageError, type McpScope } from "./mcp-add-parse";
import { openBrowser } from "./open-browser";

/** One-line target summary for list/get output. */
function describeTarget(cfg: McpServerConfig): string {
    if (isHttpServer(cfg)) {
        const auth = cfg.auth === "oauth" ? " (oauth)" : cfg.headers ? " (header auth)" : "";
        return `${cfg.type} ${cfg.url}${auth}`;
    }
    const args = cfg.args?.length ? " " + cfg.args.join(" ") : "";
    return `stdio ${cfg.command}${args}`;
}

/** Every configured server across both scopes, with its scope tag. */
function allServers(cwd: string): Array<{ name: string; cfg: McpServerConfig; scope: McpScope }> {
    const out: Array<{ name: string; cfg: McpServerConfig; scope: McpScope }> = [];
    for (const [name, cfg] of Object.entries(getGlobalServers())) out.push({ name, cfg, scope: "user" });
    for (const [name, cfg] of Object.entries(getProjectServers(cwd))) out.push({ name, cfg, scope: "project" });
    return out;
}

/**
 * Stop before writing an entry that can never authenticate.
 *
 * "Added" followed by a sign-in that is refused every time is worse than a
 * refusal: it leaves a row in settings.json that looks like configuration and
 * behaves like a fault, and sends the user off to debug their own setup.
 */
function refuseUnsupported(cfg: McpServerConfig): void {
    if (!isHttpServer(cfg)) return;
    const reason = unsupportedRemoteServer(cfg.url);
    if (reason) throw new McpUnsupportedServerError(reason);
}

function cmdAdd(args: string[]): void {
    const { name, cfg, scope } = buildAddConfig(args);
    refuseUnsupported(cfg);
    const cwd = process.cwd();
    const merged = loadMcpServers(cwd);
    if (merged[name]) {
        console.log(`Note: replacing existing MCP server "${name}".`);
    }
    if (scope === "project") addProjectServer(cwd, name, cfg);
    else addServer(name, cfg);

    const where = scope === "project" ? projectServersPath(cwd) : `~/${CONFIG_DIR_NAME}/settings.json`;
    console.log(`Added MCP server "${name}" — ${describeTarget(cfg)}  [scope: ${scope}]`);
    console.log(`  written to ${where}`);
    if (isHttpServer(cfg) && cfg.auth === "oauth") {
        console.log(`\n  This server uses OAuth. Sign in with:\n    ${PRODUCT_NAME} mcp login ${name}`);
    }
}

function cmdList(cwd: string): void {
    const servers = allServers(cwd);
    if (servers.length === 0) {
        console.log(`No MCP servers configured.\nAdd one with:  ${PRODUCT_NAME} mcp add --transport http <name> <url>`);
        return;
    }
    for (const { name, cfg, scope } of servers) {
        const disabled = cfg.enabled === false ? "  (disabled)" : "";
        console.log(`${name}  —  ${describeTarget(cfg)}  [${scope}]${disabled}`);
    }
}

function cmdGet(args: string[]): void {
    const name = firstPositional(args);
    if (!name) throw new McpUsageError(`usage: ${PRODUCT_NAME} mcp get <name>`);
    const found = allServers(process.cwd()).find((s) => s.name === name);
    if (!found) throw new McpUsageError(`no MCP server named "${name}"`);
    console.log(`${name}  [scope: ${found.scope}]`);
    console.log(describeTarget(found.cfg));
    // Redacted: this lands in scrollback, screen shares and pasted bug reports.
    console.log(JSON.stringify(redactServerConfig(found.cfg), null, 2));
}

function cmdRemove(args: string[]): void {
    const name = firstPositional(args);
    if (!name) throw new McpUsageError(`usage: ${PRODUCT_NAME} mcp remove <name> [--scope user|project]`);
    const cwd = process.cwd();
    const wanted = scopeFlag(args);
    let removed: McpScope | undefined;
    if ((!wanted || wanted === "user") && removeServer(name)) removed = "user";
    else if ((!wanted || wanted === "project") && removeProjectServer(cwd, name)) removed = "project";
    if (!removed) {
        throw new McpUsageError(`no MCP server named "${name}"${wanted ? ` in scope ${wanted}` : ""}`);
    }
    // Only forget the OAuth session once nothing of that name is configured
    // anywhere: removing the project copy of a server that also exists in user
    // scope must not sign the surviving one out.
    if (!loadMcpServers(cwd)[name]) clearMcpAuth(name);
    console.log(`Removed MCP server "${name}" [scope: ${removed}]`);
}

function cmdSetEnabled(args: string[], enabled: boolean): void {
    const name = firstPositional(args);
    if (!name) throw new McpUsageError(`usage: ${PRODUCT_NAME} mcp ${enabled ? "enable" : "disable"} <name>`);
    const cwd = process.cwd();
    const wanted = scopeFlag(args);
    const ok =
        (!wanted || wanted === "user" ? setServerEnabled(name, enabled) : false) ||
        (!wanted || wanted === "project" ? setProjectServerEnabled(cwd, name, enabled) : false);
    if (!ok) throw new McpUsageError(`no MCP server named "${name}"`);
    console.log(`${enabled ? "Enabled" : "Disabled"} MCP server "${name}"`);
}

async function cmdLogin(args: string[]): Promise<void> {
    const name = firstPositional(args);
    if (!name) throw new McpUsageError(`usage: ${PRODUCT_NAME} mcp login <name>`);
    const cfg = loadMcpServers(process.cwd())[name];
    if (!cfg) throw new McpUsageError(`no MCP server named "${name}"`);
    if (!isHttpServer(cfg)) throw new McpUsageError(`"${name}" is a stdio server — OAuth only applies to http/sse`);
    // A server already in settings.json (added by an older loop, or by hand)
    // still gets the answer before a browser opens on a doomed consent screen.
    refuseUnsupported(cfg);
    console.log(`Authorizing "${name}"…`);
    await authorizeServer(name, cfg, (url) => {
        console.log(`\nOpening your browser to:\n  ${url}\n`);
        openBrowser(url);
    });
    console.log(`Authorized "${name}". It will connect on next launch.`);
}

function cmdAddJson(args: string[]): void {
    const positional = positionals(args);
    const name = positional[0];
    const json = positional[1];
    if (!name || !json)
        throw new McpUsageError(`usage: ${PRODUCT_NAME} mcp add-json <name> '<json>' [--scope user|project]`);
    let cfg: McpServerConfig;
    try {
        cfg = JSON.parse(json) as McpServerConfig;
    } catch (err) {
        throw new McpUsageError(`invalid JSON: ${(err as Error).message}`);
    }
    if (!cfg || typeof cfg !== "object") throw new McpUsageError("JSON must be a server config object");
    refuseUnsupported(cfg);
    const looksHttp = "url" in cfg;
    const looksStdio = "command" in cfg;
    if (!looksHttp && !looksStdio) throw new McpUsageError('config needs either "url" (http/sse) or "command" (stdio)');
    const scope = scopeFlag(args) ?? "user";
    if (scope === "project") addProjectServer(process.cwd(), name, cfg);
    else addServer(name, cfg);
    console.log(`Added MCP server "${name}" — ${describeTarget(cfg)}  [scope: ${scope}]`);
}

function printHelp(): void {
    console.log(`${PRODUCT_NAME} mcp — manage MCP (Model Context Protocol) servers

Usage:
  ${PRODUCT_NAME} mcp add [options] <name> <url>            add an http/sse server
  ${PRODUCT_NAME} mcp add [options] <name> -- <cmd> [args]  add a stdio (local) server
  ${PRODUCT_NAME} mcp add-json <name> '<json>'              add from a raw JSON config
  ${PRODUCT_NAME} mcp list                                  list configured servers
  ${PRODUCT_NAME} mcp get <name>                            show one server's config
  ${PRODUCT_NAME} mcp remove <name>                         remove a server
  ${PRODUCT_NAME} mcp enable|disable <name>                 toggle a server
  ${PRODUCT_NAME} mcp login <name>                          run the OAuth browser sign-in

Options for add:
  --transport, -t <stdio|http|sse>   transport (default: stdio)
  --scope, -s <user|project>         where to store it (default: user)
  --header, -H "Name: Value"         static auth header (repeatable, http/sse)
  --env, -e KEY=VALUE                environment variable (repeatable, stdio)
  --oauth                            use OAuth sign-in (http/sse)
  --client-id <id>                   pre-registered OAuth client id
  --client-secret <secret>           OAuth client secret (supports \${env:VAR})
  --oauth-scopes a,b,c               OAuth scopes to request

Examples:
  ${PRODUCT_NAME} mcp add --transport http docs https://code.claude.com/docs/mcp
  ${PRODUCT_NAME} mcp add --transport http figma https://mcp.figma.com/mcp --oauth
  ${PRODUCT_NAME} mcp add --transport sse linear https://mcp.linear.app/sse \\
    --header "Authorization: Bearer \${env:LINEAR_TOKEN}"
  ${PRODUCT_NAME} mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/code

Tokens: headers and \${env:VAR} placeholders resolve from your environment at
connect time, so secrets stay out of the config file.`);
}

/** Entry point wired from cli.ts; `argv` is everything after `mcp`. */
export async function cmdMcp(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    try {
        switch (sub) {
            case "add":
                cmdAdd(rest);
                return;
            case "add-json":
                cmdAddJson(rest);
                return;
            case "list":
            case "ls":
                cmdList(process.cwd());
                return;
            case "get":
                cmdGet(rest);
                return;
            case "remove":
            case "rm":
            case "delete":
                cmdRemove(rest);
                return;
            case "enable":
                cmdSetEnabled(rest, true);
                return;
            case "disable":
                cmdSetEnabled(rest, false);
                return;
            case "login":
            case "authorize":
                await cmdLogin(rest);
                return;
            case undefined:
            case "help":
            case "--help":
            case "-h":
                printHelp();
                return;
            default:
                console.error(`unknown mcp subcommand: "${sub}"\n`);
                printHelp();
                process.exitCode = 1;
        }
    } catch (err) {
        // Both are answers rather than crashes: print the message, no stack.
        if (err instanceof McpUsageError || err instanceof McpUnsupportedServerError) {
            console.error(`error: ${err.message}`);
            process.exitCode = 1;
            return;
        }
        throw err;
    }
}
