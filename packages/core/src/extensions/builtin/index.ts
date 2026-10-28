/**
 * Built-in extensions — bundled with the loop binary (statically imported, so
 * `bun --compile` includes them). They're "pre-installed": they appear in
 * `/extensions` and `loop list` without `loop install`, and the user just
 * enables the ones they want. Enable state lives in the extensions store; all
 * ship disabled by default (opt-in), so a clean install behaves exactly as
 * before until a user turns one on.
 */
import type { ExtensionModule } from "../api";
import lsp from "./lsp/index";
import ponytail from "./ponytail/index";
import caveman from "./caveman/index";
import wayfinder from "./wayfinder/index";
import rtk from "./rtk/index";
import statuslineThemes from "./statusline-themes/index";
import relay from "./relay/index";

export interface BuiltinExtension {
    name: string;
    displayName: string;
    description: string;
    module: ExtensionModule;
    /** Whether it's on unless the user disables it. All false today (opt-in). */
    defaultEnabled: boolean;
}

export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
    {
        name: "lsp",
        displayName: "LSP",
        description:
            "Code intelligence: appends type errors after write/edit, and adds an `lsp` tool for definitions, references, hover, symbols and call hierarchy.",
        module: lsp,
        defaultEnabled: false,
    },
    {
        name: "ponytail",
        displayName: "Ponytail",
        description: "Lazy senior dev — write the minimal solution (lite/full/ultra). /ponytail",
        module: ponytail,
        defaultEnabled: false,
    },
    {
        name: "caveman",
        displayName: "Caveman",
        description: "Ultra-terse replies — fewer tokens, full substance (lite/full/ultra). /caveman",
        module: caveman,
        defaultEnabled: false,
    },
    {
        name: "wayfinder",
        displayName: "Wayfinder",
        description:
            "Charts an effort too big for one session as a map of decision tickets on your issue tracker. /wayfinder",
        module: wayfinder,
        defaultEnabled: false,
    },
    {
        name: "rtk",
        displayName: "RTK Token Optimizer",
        description: "Rewrites bash commands to compress output 60-90% (needs the rtk binary). /rtk",
        module: rtk,
        defaultEnabled: false,
    },
    {
        name: "relay",
        displayName: "Relay",
        description:
            "Context windows without summaries — rolls over to a fresh window and carries your inputs, todos, files touched and unconsumed tool results across. Adds new_context, get_context_remaining and history. /relay",
        module: relay,
        defaultEnabled: false,
    },
    {
        name: "statusline-themes",
        displayName: "Status Line",
        description:
            "Custom status line — pick a layout (/statusline: compact/vitals/tokens/flex/powerline/bar) and a color (/statuscolor).",
        module: statuslineThemes,
        defaultEnabled: false,
    },
];

export function getBuiltin(name: string): BuiltinExtension | undefined {
    return BUILTIN_EXTENSIONS.find((b) => b.name === name);
}

export function isBuiltin(name: string): boolean {
    return BUILTIN_EXTENSIONS.some((b) => b.name === name);
}
