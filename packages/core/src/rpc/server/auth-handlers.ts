import { bustCatalogCache, listUsableProviders } from "../../catalog";
import {
    deleteCustomProvider,
    getActiveProvider,
    isCustomProvider,
    listAuthorizedProviders,
    loginApiKey,
    logout,
    parseCustomProviderId,
} from "../../auth";
import type { ProviderId } from "../../types";
import {
    answerAuthFlow,
    cancelAuthFlow,
    listProviderDescriptors,
    pollAuthFlow,
    startAuthFlow,
    type AuthMethod,
} from "../auth-flows";
import {
    discoverCustomProviderModels,
    listCustomProviderSummaries,
    removeCustomProvider,
    saveCustomProviderConfig,
    setActiveCustomProvider,
} from "../custom-providers";
import type { HandlerTable } from "./rpc-host";

/** Provider sign-in: status, the device/OAuth flows, custom gateways. */
export function authHandlers(): HandlerTable {
    return {
        "auth.status": async () => {
            // `providers` is what a remote client may OFFER, which includes
            // the zero-login (ollama, bedrock) and custom gateways that have
            // no auth entry — returning only logged-in providers here is
            // what made them vanish from the Telegram and web pickers.
            // `authorized` keeps the strict "has stored credentials" set.
            return {
                providers: await listUsableProviders(),
                authorized: listAuthorizedProviders(),
                active: getActiveProvider(),
            };
        },
        // Every provider a client may OFFER TO SIGN IN TO — wider than
        // auth.status, which only answers "what can run now". A settings
        // screen needs the ones you could connect, or it has nothing to
        // show but the providers you already have.
        "auth.providers": () => {
            return { providers: listProviderDescriptors(), active: getActiveProvider() };
        },
        "auth.login": (params) => {
            const provider = params.provider as ProviderId;
            const key = String(params.apiKey ?? "");
            if (!provider || !key) {
                throw new Error("provider and apiKey required");
            }
            loginApiKey(provider, key);
            // A key changes which models are available, and the catalog is
            // cached — without this the new provider's models would not
            // appear until the process restarted.
            bustCatalogCache();
            return { ok: true };
        },
        "auth.logout": (params) => {
            const provider = params.provider as ProviderId | undefined;
            logout(provider);
            if (provider && isCustomProvider(provider)) {
                deleteCustomProvider(parseCustomProviderId(provider)!);
            }
            bustCatalogCache();
            return { ok: true };
        },
        ...authFlowHandlers(),
        ...customProviderHandlers(),
    };
}

/** The logins a request/response cannot hold open — OAuth, device flows, credential probes. See rpc/auth-flows.ts. */
function authFlowHandlers(): HandlerTable {
    return {
        "auth.flow.start": (params) => {
            return startAuthFlow({
                provider: String(params.provider ?? ""),
                ...(params.method ? { method: params.method as AuthMethod } : {}),
                // An unsaved gateway signs in from its draft — see
                // rpc/custom-providers.ts.
                ...(params.custom === undefined ? {} : { custom: params.custom }),
            });
        },
        "auth.flow.poll": (params) => {
            return pollAuthFlow(String(params.flowId ?? ""), Number(params.cursor ?? 0));
        },
        "auth.flow.answer": (params) => {
            return answerAuthFlow(
                String(params.flowId ?? ""),
                String(params.promptId ?? ""),
                String(params.value ?? ""),
            );
        },
        "auth.flow.cancel": (params) => {
            return cancelAuthFlow(String(params.flowId ?? ""));
        },
    };
}

/**
 * Creating a gateway, which `auth.login` cannot do: it stores a key against a
 * provider that already exists, and a custom provider IS its config. See
 * rpc/custom-providers.ts.
 */
function customProviderHandlers(): HandlerTable {
    return {
        "auth.custom.list": () => listCustomProviderSummaries(),
        "auth.custom.discover": async (params) => await discoverCustomProviderModels(params),
        "auth.custom.save": (params) => saveCustomProviderConfig(params),
        "auth.custom.remove": (params) => removeCustomProvider(params),
        "auth.custom.setActive": (params) => setActiveCustomProvider(params),
    };
}
