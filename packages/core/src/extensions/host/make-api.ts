/**
 * Builds the `api` object handed to one extension's `activate`, from the
 * per-area factories. The registries here only record contributions; the host
 * reads them back through ContributionAggregates.
 */
import type { ExtensionAPI } from "../api";
import { EXTENSION_API_VERSION } from "../api";
import {
    readActiveBranch,
    readContextBudget,
    registerContextPolicy,
    requestContextBoundary,
} from "../../agent/context-policy";
import type { ApiContext } from "./api-context";
import { authApi, settingsApi, uiApi } from "./api-services";
import { docksApi, keymapApi, terminalApi, widgetsApi } from "./api-screen";
import { toMatcher } from "./contributions";

export type { ApiContext } from "./api-context";

export function makeExtensionApi(ctx: ApiContext): ExtensionAPI {
    const c = ctx.contributions;
    return {
        version: EXTENSION_API_VERSION,
        ui: uiApi(ctx),
        auth: authApi(ctx),
        extension: { dir: ctx.pkgDir, manifest: ctx.manifest, log: ctx.log, setStatus: ctx.setStatus },
        commands: commandsApi(ctx),
        tools: toolsApi(ctx),
        settings: settingsApi(ctx.record.name),
        themes: { register: (...themes) => c.themes.push(...themes) },
        providers: {
            register: (provider) => c.providers.set(provider.id, provider),
            unregister: (id) => c.providers.delete(id),
        },
        models: { add: (...infos) => c.modelInfos.push(...infos) },
        agents: { register: (agent) => c.agents.push(agent) },
        skills: { addDir: (dir) => c.skillDirs.push(dir) },
        turn: { use: (mw) => c.turnMws.push(mw) },
        context: contextApi(ctx),
        statusLine: {
            add: (fn) => c.statusContributors.push(fn),
            transform: (fn) => c.statusTransforms.push(fn),
            refresh: () => ctx.services().requestRender?.(),
        },
        widgets: widgetsApi(ctx),
        screen: () => ctx.services().screen?.(),
        terminal: terminalApi(ctx),
        docks: docksApi(ctx),
        keymap: keymapApi(ctx),
    };
}

function commandsApi({ contributions: c }: ApiContext): ExtensionAPI["commands"] {
    return {
        register: (cmd) => c.commandOps.push({ kind: "register", cmd }),
        unregister: (name) => c.commandOps.push({ kind: "unregister", name }),
        override: (name, cmd) => c.commandOps.push({ kind: "override", name, cmd }),
    };
}

function toolsApi({ contributions: c }: ApiContext): ExtensionAPI["tools"] {
    return {
        add: (name, tool) => c.tools.set(name, tool),
        remove: (name) => c.toolRemovals.add(name),
        grant: (agent, tool) => c.toolGrants.push({ agent, tool }),
        onCall: (match, mw) => c.toolCallMws.push({ match: toMatcher(match), mw }),
        onResult: (match, mw) => c.toolResultMws.push({ match: toMatcher(match), mw }),
        summary: (match, fn) => c.toolSummaries.push({ match: toMatcher(match), fn }),
    };
}

function contextApi({ contributions: c }: ApiContext): ExtensionAPI["context"] {
    return {
        registerPolicy: (policy) => {
            c.contextPolicies.push(policy.name);
            registerContextPolicy(policy);
        },
        requestBoundary: (handoff) => requestContextBoundary(handoff),
        read: () => readContextBudget(),
        branch: () => readActiveBranch(),
    };
}
