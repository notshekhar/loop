import type { GenericOAuthCredentials } from "../../types";

export interface OAuthLoginCallbacks {
    onAuth: (info: { url: string; instructions?: string }) => void;
    onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
    /** Register a new account instead of reusing the last one (ChatGPT). */
    freshRegistration?: boolean;
}

export interface OAuthProviderInterface {
    id: string;
    name: string;
    login(cb: OAuthLoginCallbacks): Promise<GenericOAuthCredentials>;
    refreshToken(creds: GenericOAuthCredentials): Promise<GenericOAuthCredentials>;
    getApiKey(creds: GenericOAuthCredentials): string;
    /** End the renewable session server-side on sign-out, when the provider supports it. */
    revoke?(creds: GenericOAuthCredentials): Promise<void>;
}
