import { isTrusted } from "../../agent/trust";
import {
    isHttpServer,
    isMcpEnabled,
    isServerEnabled,
    loadConnectableServers,
    resolveSecretMap,
    resolveSecrets,
    type McpServerConfig,
} from "../../mcp/config";

/**
 * The MCP servers configured in loop, in a form each native agent's CLI can
 * be handed — so a server the user added to loop works whichever agent
 * answers, not only loop's own models. The agent connects them itself.
 *
 * Left out, on purpose:
 * - disabled servers, and project servers in an untrusted folder (the same
 *   rule loop's own connections follow);
 * - OAuth servers: the token lives in loop's auth store and loop refreshes
 *   it; a CLI handed a URL alone would just fail to connect;
 * - servers limited with `allowedTools`: no CLI can restrict a server to a
 *   subset, so handing it over would give the agent tools the user withheld.
 *   (`deniedTools` does translate — see `deniedTools` below.)
 */
export type NativeMcpServer =
    | { name: string; kind: "stdio"; command: string; args: string[]; env?: Record<string, string>; deniedTools: string[] }
    | { name: string; kind: "http" | "sse"; url: string; headers?: Record<string, string>; deniedTools: string[] };

export function nativeMcpServers(cwd: string): NativeMcpServer[] {
    if (!isMcpEnabled()) return [];
    const servers = loadConnectableServers(cwd, isTrusted(cwd));
    const out: NativeMcpServer[] = [];
    for (const [name, cfg] of Object.entries(servers)) {
        const server = toNative(name, cfg);
        if (server) out.push(server);
    }
    return out;
}

function toNative(name: string, cfg: McpServerConfig): NativeMcpServer | undefined {
    if (!isServerEnabled(cfg) || cfg.allowedTools !== undefined) return undefined;
    const deniedTools = cfg.deniedTools ?? [];
    if (isHttpServer(cfg)) {
        if (cfg.auth === "oauth") return undefined;
        return { name, kind: cfg.type, url: resolveSecrets(cfg.url), headers: resolveSecretMap(cfg.headers), deniedTools };
    }
    return { name, kind: "stdio", command: cfg.command, args: cfg.args ?? [], env: resolveSecretMap(cfg.env), deniedTools };
}
