import {
    agentExists,
    agentToolNames,
    deleteAgent,
    getAgentModel,
    getAgentPrompt,
    getAgentTools,
    hasBuiltinOverride,
    isBuiltinAgent,
    isValidAgentName,
    listAgents,
    saveAgent,
} from "../../agent/agents";
import type { HandlerTable, RpcHost } from "./rpc-host";

type AgentHost = Pick<RpcHost, "commands">;

/** Named agents and the tools each may use. */
export function agentHandlers(host: AgentHost): HandlerTable {
    return {
        "agent.list": () => {
            // Name, description and model only: `prompt` can be pages long
            // and no client needs it to render a picker.
            return listAgents()
                .filter((a) => !a.hidden)
                .map((a) => ({
                    name: a.name,
                    builtin: a.builtin,
                    ...(a.model === undefined ? {} : { model: a.model }),
                    ...(a.tools === undefined ? {} : { tools: a.tools }),
                }));
        },
        "agent.get": (params) => getAgent(String(params.name ?? "")),
        "agent.save": (params) => saveAgentFromParams(host, params),
        "agent.delete": (params) => {
            // For a custom agent this removes it; for a built-in it drops
            // the override file, resetting the prompt. `{ok:false}` means
            // there was no file — nothing to reset — not an error.
            const name = String(params.name ?? "");
            return { ok: deleteAgent(name) };
        },
        "agent.tools": () => {
            // The allowlist an agent editor offers. Dynamic, not the static
            // constant, so tools registered by extensions are offerable.
            return agentToolNames();
        },
    };
}

/**
 * The editor's read: unlike agent.list this DOES carry the prompt, because
 * editing it is the whole point. Hidden built-ins are fetchable by name — they
 * are only hidden from the picker, not secret.
 */
function getAgent(name: string) {
    if (!agentExists(name)) throw new Error(`Unknown agent: ${name}`);
    const builtin = isBuiltinAgent(name);
    return {
        name,
        prompt: getAgentPrompt(name) ?? "",
        builtin,
        // Undefined means "all tools" — kept as an absent field so
        // a client can tell it apart from an empty allowlist.
        ...(getAgentTools(name) === undefined ? {} : { tools: getAgentTools(name) }),
        ...(getAgentModel(name) === undefined ? {} : { model: getAgentModel(name) }),
        // A built-in's tool set is fixed; only its prompt and model
        // are editable, and `hasOverride` is what makes "reset to
        // built-in" offerable.
        toolsEditable: !builtin,
        hasOverride: hasBuiltinOverride(name),
    };
}

/**
 * Create or update. Mirrors the TUI's /agents editor, including its rule that
 * a built-in's tool set is fixed (saveAgent drops `tools` for built-ins rather
 * than trusting the caller).
 */
function saveAgentFromParams(host: AgentHost, params: Record<string, unknown>) {
    const name = String(params.name ?? "").trim();
    if (!isValidAgentName(name)) {
        throw new Error(`Invalid agent name: ${name} (alphanumeric and dashes, 32 chars max)`);
    }
    const prompt = String(params.prompt ?? "");
    if (!prompt.trim()) throw new Error("An agent needs a system prompt");
    // A name that is already a slash command but not an agent would
    // produce an agent nobody can invoke — the TUI refuses it too.
    if (!agentExists(name) && host.commands.has(name)) {
        throw new Error(`"${name}" is already a command`);
    }
    const tools = Array.isArray(params.tools) ? (params.tools as unknown[]).map(String) : undefined;
    const model = typeof params.model === "string" ? params.model : undefined;
    saveAgent(name, prompt, tools, model);
    return { ok: true, name };
}
