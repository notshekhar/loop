// AI SDK prints advisory warnings to the console mid-stream, which tears the
// TUI's differential rendering. Disable globally before anything runs.
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

import type { ProviderId } from "@notshekhar/loop-core";
import { parseArgs } from "./args";

// The interactive app and subcommands transitively pull in the TUI, highlight.js,
// and core (~400ms of module eval). Dynamic-import them per command so
// --version/--help stay instant and each command only loads what it needs.
const commands = () => import("./commands");
const extCommands = () => import("./ext-commands");
const interactive = () => import("./interactive/app");

// injected at build time via tsup define
declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    // Refuse an invocation we didn't understand instead of running the nearest
    // thing to it: an unknown command used to open the TUI, and an unknown
    // flag used to be kept and ignored (a typo'd --model billed a whole turn
    // on the default model). Checked before --version/--help so a typo is
    // never masked by a flag that happens to parse.
    if (args.errors.length > 0) {
        // Brand-correct name for the messages; the import cost only lands on
        // an invocation that is already failing.
        const { PRODUCT_NAME } = await import("@notshekhar/loop-core");
        for (const e of args.errors) console.error(`${PRODUCT_NAME}: ${e}`);
        console.error(`Run \`${PRODUCT_NAME} help\` for usage.`);
        process.exit(1);
    }

    if (args.flags.version) {
        console.log(VERSION);
        return;
    }
    if (args.flags.help) {
        (await commands()).printHelp(VERSION);
        return;
    }

    // Lossless one-time move of a pre-rename config dir (no-op unless a
    // product rename lists one in LEGACY_CONFIG_DIR_NAMES). Runs after the
    // instant --version/--help paths so they stay disk-free, and before any
    // command reads settings/auth/sessions. Dynamically imported so it
    // doesn't pull core into the fast paths above.
    (await import("@notshekhar/loop-core")).migrateLegacyConfig();

    switch (args.cmd) {
        case "version":
            console.log(VERSION);
            return;
        case "help":
            (await commands()).printHelp(VERSION);
            return;
        case "upgrade":
        case "update":
            await (await commands()).runUpgrade(VERSION, { force: Boolean(args.flags.force) });
            return;
        case "login":
            await (await commands()).cmdLogin(args.positional[0]);
            return;
        case "logout":
            await (await commands()).cmdLogout(args.positional[0] as ProviderId | undefined);
            return;
        case "sessions":
            await (await commands()).cmdSessions(args);
            return;
        case "archive":
            await (await commands()).cmdArchive(args, true);
            return;
        case "unarchive":
            await (await commands()).cmdArchive(args, false);
            return;
        case "rpc":
            (await commands()).cmdRpc(args);
            return;
        case "serve":
            (await commands()).cmdServe(args);
            return;
        case "gateways":
        case "gateway":
            await (await commands()).cmdGateways(args);
            return;
        case "telegram":
            // Back-compat alias: run the Telegram gateway daemon in the foreground.
            await (await commands()).cmdGateways(args, "telegram");
            return;
        case "mcp":
            await (await import("./mcp-commands")).cmdMcp(process.argv.slice(3));
            return;
        case "run":
            await (await commands()).cmdRun(args);
            return;
        case "goals":
        case "background":
            await (await import("./goals/commands")).cmdGoals(args);
            return;
        case "man": {
            const { PRODUCT_NAME } = await import("@notshekhar/loop-core");
            const { installManPage, manPageSource, showManPage } = await import("./manpage");
            if (args.flags.install) {
                // Writing it to the user manpath is what makes plain `man loop`
                // work; the installer calls this too.
                console.log(`installed ${installManPage(PRODUCT_NAME, VERSION)}`);
            } else if (args.flags.path) {
                console.log(manPageSource(PRODUCT_NAME, VERSION));
            } else {
                showManPage(PRODUCT_NAME, VERSION);
            }
            return;
        }
        case "completion": {
            const { completionScript, installHint, SUPPORTED_SHELLS } = await import("./completion");
            const shell = args.positional[0];
            if (!shell || !(SUPPORTED_SHELLS as readonly string[]).includes(shell)) {
                const { PRODUCT_NAME } = await import("@notshekhar/loop-core");
                console.error(`Usage: ${PRODUCT_NAME} completion <${SUPPORTED_SHELLS.join("|")}>`);
                process.exitCode = 1;
                return;
            }
            const s = shell as (typeof SUPPORTED_SHELLS)[number];
            // Script on stdout, instructions on stderr — so redirecting to a
            // file gives a file the shell can actually load.
            console.log(completionScript(s));
            console.error(installHint(s));
            return;
        }
        case "models":
            await (await commands()).cmdModels();
            return;
        case "artifacts":
            await (await commands()).cmdArtifacts(args);
            return;
        case "whoami":
            (await commands()).cmdWhoami();
            return;
        case "cost":
            if (args.positional[0] === "audit") {
                await (await commands()).cmdCostAudit();
            } else {
                console.log(
                    `Usage: ${(await import("@notshekhar/loop-core")).PRODUCT_NAME} cost audit — reconcile the cost ledger`,
                );
            }
            return;
        case "install":
            await (await extCommands()).cmdInstall(args);
            return;
        case "link":
            await (await extCommands()).cmdLink(args);
            return;
        case "remove":
        case "uninstall":
            await (await extCommands()).cmdRemoveExtension(args);
            return;
        case "extensions":
            (await extCommands()).cmdListExtensions();
            return;
        case "enable":
            (await extCommands()).cmdSetExtensionEnabled(args, true);
            return;
        case "disable":
            (await extCommands()).cmdSetExtensionEnabled(args, false);
            return;
        // No command: the interactive TUI. An *unknown* command never reaches
        // here — parseArgs rejects it above, so a typo can no longer open a
        // chat session instead of saying it was a typo.
        case undefined:
            await (
                await interactive()
            ).runInteractive({
                modelId: (args.flags.model as string) || undefined,
                provider: (args.flags.provider as ProviderId) || undefined,
                cwd: (args.flags.cwd as string) || process.cwd(),
                sessionId: (args.flags.session as string) || undefined,
                version: VERSION,
            });
            return;
        default:
            // parseArgs accepted it, so spec.ts lists a command this switch
            // does not dispatch — a table/dispatch mismatch, not user error.
            console.error(`internal: no handler for command "${args.cmd}" (packages/cli/src/spec.ts lists it)`);
            process.exit(70);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
