/**
 * Public entry point for the extension system. The host loads enabled
 * extensions at startup and aggregates their contributions; install/link/remove
 * manage what's installed (deps resolved via the embedded Bun runtime).
 */
export { getExtensionHost, ExtensionHost, type HostServices } from "./host";
export { installExtension, linkExtension, removeExtension, syncExtensions, type InstallResult } from "./install";
export {
    listRecords,
    getRecord,
    setRecordEnabled,
    deleteRecord,
    getBuiltinEnabled,
    setBuiltinEnabled,
    extensionsDir,
    extensionDir,
    type ExtensionRecord,
} from "./store";
export { BUILTIN_EXTENSIONS, getBuiltin, isBuiltin, type BuiltinExtension } from "./builtin";
export { parseSource, type ParsedSource, type SourceKind } from "./sources";
export {
    EXTENSION_API_VERSION,
    type ExtensionAPI,
    type ExtensionUI,
    type ExtensionAuth,
    type UiSelectItem,
    type LoopbackOAuthOptions,
    type LoopbackOAuthResult,
    type ExtensionModule,
    type ExtensionManifest,
    type ProviderPlugin,
    type ProviderSdk,
    type ProviderModelSpec,
    type ProviderAuth,
    type ProviderRuntime,
    type AgentPlugin,
    type TurnMiddleware,
    type ToolCallMiddleware,
    type ToolResultMiddleware,
    type ToolSummaryRenderer,
    type ToolSummaryContext,
    type ExtensionTheme,
    type ExtensionThemeJson,
    type TurnContext,
    type ToolCallContext,
    type StatusLineContext,
    type StatusSegment,
    type WidgetRenderer,
    type WidgetOptions,
    type WidgetHandle,
    type WidgetMouseEvent,
    type TerminalHandle,
    type TerminalSpawnOptions,
    type DockOptions,
    type DockHandle,
    type StatusLineContributor,
    type StatusLineTransform,
} from "./api";
export { providerModelToInfo, collectProviderModelInfos } from "./providers";
