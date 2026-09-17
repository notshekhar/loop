/**
 * MCP server configuration. Servers are declared in ~/.loop/settings.json under
 * `mcpServers`, and optionally overridden per-project in <cwd>/.loop/mcp.json.
 * Two sources only (global + project) — project entries win on name collision.
 */
import { CONFIG_DIR_NAME } from "../brand";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSetting, setSetting } from "../settings";

/**
 * Which of a server's tools this project is willing to use.
 *
 * Connecting to a server has always been all-or-nothing: every tool it exposes
 * joined every turn's tool set. That is a context problem (one verbose server
 * can outweigh loop's entire builtin toolset) and a safety one — a server whose
 * read tools you want may also ship a `delete_everything` you do not.
 *
 * Filtering here rather than at call time is deliberate: a denied tool is never
 * advertised, so the model never plans around it and never spends tokens
 * reading its schema.
 */
export interface ToolAccessPolicy {
    /** If set, ONLY these tools are used. Names are the server's own, unprefixed. */
    allowedTools?: string[];
    /** Never used. Takes precedence over `allowedTools`. */
    deniedTools?: string[];
}

/** A local server launched as a subprocess; tools speak over stdio. */
export interface StdioServerConfig extends ToolAccessPolicy {
    type?: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** Default true. Set false to keep the entry but skip connecting. */
    enabled?: boolean;
}

/**
 * A remote server reached over streamable HTTP or SSE. The two share a URL
 * shape, so a connect that fails because the server speaks the other one is
 * retried on it automatically — `type` is a starting guess, not a verdict.
 */
export interface HttpServerConfig extends ToolAccessPolicy {
    type: "http" | "sse";
    url: string;
    headers?: Record<string, string>;
    /** "oauth" → run the browser login flow; omit for static-header auth. */
    auth?: "oauth";
    enabled?: boolean;
    /**
     * Pre-registered OAuth client. Set these for servers that don't allow
     * anonymous dynamic client registration (e.g. Figma returns 403) — loop then
     * skips registration and authorizes with the credentials you provide.
     * `clientSecret` supports `${env:VAR}`; omit it for public (PKCE) clients.
     */
    clientId?: string;
    clientSecret?: string;
    /** OAuth scopes to request — some servers require an explicit scope. */
    scopes?: string[];
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export function isHttpServer(cfg: McpServerConfig): cfg is HttpServerConfig {
    return cfg.type === "http" || cfg.type === "sse";
}

/**
 * Master switch for MCP. Default ON — only an explicit `mcp: false` disables it.
 * Callers that spawn/connect servers additionally gate on project trust; this
 * helper is just the setting so the toggle, command visibility, and agent loop
 * all agree on one rule.
 */
export function isMcpEnabled(): boolean {
    return getSetting("mcp") !== false;
}

export function isServerEnabled(cfg: McpServerConfig): boolean {
    return cfg.enabled !== false;
}

/**
 * Whether one of a server's tools may be used, by its own (unprefixed) name.
 *
 * Deny wins over allow, so `allowedTools` can be broad while `deniedTools`
 * carves out the one destructive thing — the combination people actually
 * write. An empty `allowedTools` array means "nothing", not "everything":
 * writing an empty list and getting every tool is the kind of surprise that
 * only ever goes one way.
 */
export function isToolAllowed(cfg: ToolAccessPolicy, tool: string): boolean {
    if (cfg.deniedTools?.includes(tool)) return false;
    if (cfg.allowedTools === undefined) return true;
    return cfg.allowedTools.includes(tool);
}

/** Default number of MCP tools above which the turn switches to search mode. */
export const DEFAULT_TOOL_SEARCH_THRESHOLD = 50;

/**
 * Whether this turn should hide the individual MCP tools behind `mcp_tools`.
 *
 * The setting is deliberately three-valued: a number to move the line, `false`
 * to keep every tool advertised however many there are, `true` to always
 * search. Anything else falls back to the default rather than guessing.
 */
export function shouldUseToolSearch(toolCount: number): boolean {
    const setting = getSetting("mcpToolSearch");
    if (setting === false) return false;
    if (setting === true) return true;
    const threshold = typeof setting === "number" && setting >= 0 ? setting : DEFAULT_TOOL_SEARCH_THRESHOLD;
    return toolCount > threshold;
}

/** True when a policy would filter anything at all — used to explain a tool count. */
export function hasToolPolicy(cfg: ToolAccessPolicy): boolean {
    return cfg.allowedTools !== undefined || (cfg.deniedTools?.length ?? 0) > 0;
}

/**
 * Substitute `${env:VAR}` placeholders from process.env so tokens live in the
 * environment, not in plaintext config. Unknown vars resolve to an empty
 * string (the request then simply fails auth, which surfaces clearly).
 */
const ENV_PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveSecrets(value: string): string {
    return value.replace(ENV_PLACEHOLDER, (_, name: string) => process.env[name] ?? "");
}

export function resolveSecretMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!map) return undefined;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) resolved[key] = resolveSecrets(value);
    return resolved;
}

/**
 * Merge global (settings.json) and project (<cwd>/.loop/mcp.json) server maps.
 * A malformed project file is ignored rather than crashing startup.
 */
export function loadMcpServers(cwd: string): Record<string, McpServerConfig> {
    const global = getSetting("mcpServers") ?? {};
    const project = loadProjectServers(cwd);
    return { ...global, ...project };
}

/**
 * The servers this process may actually CONNECT in `cwd`, as opposed to the
 * ones it lists.
 *
 * Project trust exists so a repo you just cloned can't run its own hooks and
 * skills behind your back — so it gates the servers that ride in with the repo
 * (`<cwd>/.loop/mcp.json`). It has no business gating the ones you declared in
 * your own `~/.loop/settings.json`: those are yours, the repo has no say in
 * them, and withholding them meant a user-scope server silently did nothing in
 * any folder that had never been trusted — including every folder where the
 * trust prompt never appears, which has no in-product way to fix.
 */
export function loadConnectableServers(cwd: string, trusted: boolean): Record<string, McpServerConfig> {
    return trusted ? loadMcpServers(cwd) : getGlobalServers();
}

/**
 * Project servers held back for lack of trust — what a UI should say so.
 * Only the ones that would otherwise have connected: naming a server the user
 * has explicitly disabled, as though trust were what is stopping it, sends
 * them off to fix the wrong thing.
 */
export function withheldProjectServers(cwd: string, trusted: boolean): string[] {
    if (trusted) return [];
    return Object.entries(loadProjectServers(cwd))
        .filter(([, cfg]) => isServerEnabled(cfg))
        .map(([name]) => name);
}

/** Header names whose value is a credential, however the server spells it. */
const SECRET_KEY = /authorization|auth[-_]?token|api[-_]?key|access[-_]?key|secret|password|cookie|token/i;

/** A `${env:VAR}` reference is a pointer to a secret, not the secret itself. */
function isEnvReference(value: string): boolean {
    return /^\s*\$\{env:[A-Za-z_][A-Za-z0-9_]*\}\s*$/.test(value);
}

function redactMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!map) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
        out[key] = SECRET_KEY.test(key) && !isEnvReference(value) ? "<redacted>" : value;
    }
    return out;
}

/**
 * A server's config with its credentials masked, for anything that prints one.
 *
 * `mcp get` dumped the entry verbatim, so a bearer token pasted into `--header`
 * or a literal `clientSecret` went straight to the terminal — into scrollback,
 * into a screen share, into CI logs, into the paste someone makes when asking
 * for help. `${env:VAR}` references are left legible on purpose: they name a
 * variable rather than reveal one, and hiding them would obscure the very thing
 * that tells the user their secret is being kept out of the file properly.
 */
export function redactServerConfig(cfg: McpServerConfig): McpServerConfig {
    if (isHttpServer(cfg)) {
        return {
            ...cfg,
            ...(cfg.headers ? { headers: redactMap(cfg.headers)! } : {}),
            ...(cfg.clientSecret && !isEnvReference(cfg.clientSecret) ? { clientSecret: "<redacted>" } : {}),
        };
    }
    return { ...cfg, ...(cfg.env ? { env: redactMap(cfg.env)! } : {}) };
}

/** Servers declared in global settings (the surface /mcp can edit). */
export function getGlobalServers(): Record<string, McpServerConfig> {
    return getSetting("mcpServers") ?? {};
}

export function isGlobalServer(name: string): boolean {
    return name in getGlobalServers();
}

/** Add or replace a global server in ~/.loop/settings.json. */
export function addServer(name: string, cfg: McpServerConfig): void {
    setSetting("mcpServers", { ...getGlobalServers(), [name]: cfg });
}

/** Flip a global server's enabled flag. Returns false if not a global server. */
export function setServerEnabled(name: string, enabled: boolean): boolean {
    const servers = getGlobalServers();
    if (!servers[name]) return false;
    setSetting("mcpServers", { ...servers, [name]: { ...servers[name], enabled } });
    return true;
}

/** Delete a global server. Returns false if not a global server. */
export function removeServer(name: string): boolean {
    const servers = getGlobalServers();
    if (!servers[name]) return false;
    const next = { ...servers };
    delete next[name];
    setSetting("mcpServers", next);
    return true;
}

/** Path of the project-scoped server file for a working directory. */
export function projectServersPath(cwd: string): string {
    return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

/** Servers declared in <cwd>/.loop/mcp.json (the project scope, shareable via the repo). */
export function getProjectServers(cwd: string): Record<string, McpServerConfig> {
    return loadProjectServers(cwd);
}

function loadProjectServers(cwd: string): Record<string, McpServerConfig> {
    const path = projectServersPath(cwd);
    if (!existsSync(path)) return {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        // Accept both `{ mcpServers: {...} }` and a bare `{...}` map.
        const servers = parsed?.mcpServers ?? parsed;
        return servers && typeof servers === "object" ? servers : {};
    } catch {
        return {};
    }
}

/** Write the project server map back to <cwd>/.loop/mcp.json in canonical form. */
function writeProjectServers(cwd: string, servers: Record<string, McpServerConfig>): void {
    const path = projectServersPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
}

/** Add or replace a project-scoped server. */
export function addProjectServer(cwd: string, name: string, cfg: McpServerConfig): void {
    writeProjectServers(cwd, { ...loadProjectServers(cwd), [name]: cfg });
}

/** Flip a project server's enabled flag. Returns false if not a project server. */
export function setProjectServerEnabled(cwd: string, name: string, enabled: boolean): boolean {
    const servers = loadProjectServers(cwd);
    if (!servers[name]) return false;
    writeProjectServers(cwd, { ...servers, [name]: { ...servers[name], enabled } });
    return true;
}

/** Delete a project-scoped server. Returns false if it wasn't declared there. */
export function removeProjectServer(cwd: string, name: string): boolean {
    const servers = loadProjectServers(cwd);
    if (!servers[name]) return false;
    const next = { ...servers };
    delete next[name];
    writeProjectServers(cwd, next);
    return true;
}
