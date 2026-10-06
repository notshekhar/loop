import { findClaudeBinary, type ClaudeCodeProbe } from "./claude-code";
import { findCursorBinary, type CursorProbe } from "./cursor";
import { peekProbe } from "./probe-cache";
import type { NativeAgentProviderId } from "./shared";

export {
    isNativeAgentProvider,
    NATIVE_AGENT_PROVIDERS,
    type NativeAgentProviderId,
    type NativeAgentTurnContext,
} from "./shared";
export {
    CLAUDE_CODE_PROVIDER,
    claudeReasoningOptions,
    createClaudeCodeModel,
    findClaudeBinary,
    probeClaudeCode,
    type ClaudeCodeModel,
    type ClaudeCodeProbe,
} from "./claude-code";
export {
    createCursorModel,
    CURSOR_PROVIDER,
    findCursorBinary,
    groupCursorModels,
    parseCursorVariant,
    probeCursor,
    resolveCursorModel,
    selectCursorVariant,
    type CursorFamily,
    type CursorProbe,
} from "./cursor";

/**
 * Last-known status without spawning anything — for surfaces that render
 * synchronously (provider lists). The catalog keeps it fresh.
 */
export function peekNativeAgent(provider: NativeAgentProviderId): { installed: boolean; loggedIn: boolean } {
    const installed = Boolean(provider === "claude-code" ? findClaudeBinary() : findCursorBinary());
    const probe = peekProbe<ClaudeCodeProbe | CursorProbe | null>(provider);
    return { installed, loggedIn: installed && probe?.loggedIn === true };
}
