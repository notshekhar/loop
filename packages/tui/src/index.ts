// Core TUI interfaces and classes

export { Marked, type Token, type Tokens } from "marked";
// Autocomplete support
export {
    type AutocompleteItem,
    type AutocompleteProvider,
    type AutocompleteSuggestions,
    CombinedAutocompleteProvider,
    type SlashCommand,
} from "./autocomplete";
// Components
export { Box } from "./components/box";
export { CancellableLoader } from "./components/cancellable-loader";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor";
export { HStack } from "./components/h-stack";
export { Image, type ImageOptions, type ImageTheme } from "./components/image";
export { Input } from "./components/input";
export { Loader, type LoaderIndicatorOptions } from "./components/loader";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown";
export {
    ScrollView,
    type ScrollViewOptions,
    type ScrollViewScrollbar,
    type ScrollViewScrollToOptions,
} from "./components/scroll-view";
export {
    type SelectItem,
    SelectList,
    type SelectListLayoutOptions,
    type SelectListTheme,
    type SelectListTruncatePrimaryContext,
} from "./components/select-list";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list";
export { Spacer } from "./components/spacer";
export { Text } from "./components/text";
export { TruncatedText } from "./components/truncated-text";
export {
    type StackChild,
    type StackEntry,
    type StackEntryOptions,
    type StackOptions,
    VStack,
} from "./components/v-stack";
// Editor component interface (for custom editors)
export type { EditorComponent } from "./editor-component";
// Fuzzy matching
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy";
// Keybindings
export {
    getKeybindings,
    type Keybinding,
    type KeybindingConflict,
    type KeybindingDefinition,
    type KeybindingDefinitions,
    type Keybindings,
    type KeybindingsConfig,
    KeybindingsManager,
    setKeybindings,
    TUI_KEYBINDINGS,
} from "./keybindings";
// Keyboard input handling
export {
    decodeKittyPrintable,
    isKeyRelease,
    isKeyRepeat,
    isKittyProtocolActive,
    Key,
    type KeyEventType,
    type KeyId,
    matchesKey,
    parseKey,
    setKittyProtocolActive,
} from "./keys";
// LaTeX rendering
export { type RenderLatexOptions, renderLatex } from "./latex";
// Mermaid diagram rendering
export { type MermaidStyle, type RenderMermaidOptions, renderMermaid } from "./mermaid";
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer";
// Terminal interface and implementations
export { ProcessTerminal, type Terminal } from "./terminal";
// Terminal colors
export {
    parseOsc11BackgroundColor,
    parseTerminalColorSchemeReport,
    type RgbColor,
    type TerminalColorScheme,
} from "./terminal-colors";
// Terminal image support
export {
    allocateImageId,
    type CellDimensions,
    calculateImageRows,
    deleteAllKittyImages,
    deleteKittyImage,
    detectCapabilities,
    encodeITerm2,
    encodeKitty,
    getCapabilities,
    getCellDimensions,
    getGifDimensions,
    getImageDimensions,
    getJpegDimensions,
    getPngDimensions,
    getWebpDimensions,
    hyperlink,
    type ImageDimensions,
    type ImageProtocol,
    type ImageRenderOptions,
    imageFallback,
    renderImage,
    resetCapabilitiesCache,
    setCapabilities,
    setCapabilityOverrides,
    setCellDimensions,
    type TerminalCapabilities,
} from "./terminal-image";
export {
    type Component,
    Container,
    CURSOR_MARKER,
    compositeTuiLine,
    type Focusable,
    isFocusable,
    isViewportTUI,
    type OverlayAnchor,
    type OverlayHandle,
    type OverlayMargin,
    type OverlayOptions,
    type OverlayRect,
    type OverlayUnfocusOptions,
    type SizeValue,
    type TUI,
    type TuiInputListener,
    type TuiInputListenerResult,
    type TuiMode,
    type TuiStopOptions,
    type ViewportTUI,
} from "./tui";
export { TuiAltScreen, type TuiAltScreenOptions } from "./tui-alt-screen";
export { TuiMainScreen, type TuiMainScreenRenderState } from "./tui-main-screen";
// Utilities
export {
    getOsc8LinkAtColumn,
    sliceByColumn,
    stripTerminalSequences,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "./utils";
