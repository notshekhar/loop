import { findAntigravityBinary, type AntigravityProbe } from "./antigravity";
import { findClaudeBinary, type ClaudeCodeProbe } from "./claude-code";
import { findCodexBinary, type CodexProbe } from "./codex";
import { findCursorBinary, type CursorProbe } from "./cursor";
export {
    CODEX_PROVIDER,
    codexArgs,
    codexEffort,
    createCodexModel,
    findCodexBinary,
    parseCodexModels,
    probeCodex,
    type CodexModel,
    type CodexProbe,
} from "./codex";
export {
    ANTIGRAVITY_PROVIDER,
    antigravityArgs,
    createAntigravityModel,
    findAntigravityBinary,
    parseAntigravityModels,
    probeAntigravity,
    resolveAntigravityModel,
    type AntigravityFamily,
    type AntigravityProbe,
} from "./antigravity";

const FINDERS: Record<NativeAgentProviderId, () => string | undefined> = {
    "claude-code": findClaudeBinary,
    "cursor-agent": findCursorBinary,
    "codex-cli": findCodexBinary,
    antigravity: findAntigravityBinary,
};
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
    const installed = Boolean(FINDERS[provider]());
    const probe = peekProbe<ClaudeCodeProbe | CursorProbe | CodexProbe | AntigravityProbe | null>(provider);
    return { installed, loggedIn: installed && probe?.loggedIn === true };
}
