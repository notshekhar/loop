import { EventEmitter } from "node:events";
import {
    asTurnEmitter,
    closeDb,
    CostTracker,
    SessionManager,
    runTurn,
    runHooks,
    runSessionEndHooks,
    getActiveProvider,
    getMcpManager,
    getExtensionHost,
    getProjectModel,
    isMcpEnabled,
    killAllBashChildren,
    parseModelId,
    resolveSavedAgent,
    settingsStore,
    PRODUCT_NAME,
} from "@notshekhar/loop-core";
import type { ProviderId, Session } from "@notshekhar/loop-core";
import { openBrowser } from "../open-browser";
import type { OutputFormat } from "../spec";
import { createReporter } from "./reporters";

export interface PrintOptions {
    prompt: string;
    modelId?: string;
    /** Explicit --cwd; unset falls back to the resumed session's cwd, then process.cwd(). */
    cwd?: string;
    /** `--session <id>` — resume this session instead of creating one. Unknown id fails loudly. */
    sessionId?: string;
    /** Step cap for the turn (`--max-steps`); unset = maxSteps setting / unlimited. */
    maxSteps?: number;
    /** `--output-format`; defaults to the human-readable stream. */
    outputFormat?: OutputFormat;
}

/**
 * Fail before the turn exists. A JSON caller gets a result object it can parse
 * like any other — a startup failure that printed only prose would make every
 * consumer special-case "no output at all".
 */
function failEarly(format: OutputFormat, message: string): never {
    if (format === "text") process.stderr.write(`${message}\n`);
    else process.stdout.write(JSON.stringify({ type: "result", is_error: true, errors: [message] }) + "\n");
    process.exit(1);
}

export async function runPrint(opts: PrintOptions): Promise<void> {
    const format = opts.outputFormat ?? "text";
    const manager = new SessionManager();
    // Resume before model resolution: a resumed session carries its own model
    // and cwd as defaults. open() throws on an unknown id — never fall back to
    // a fresh session, silent forking is worse than an error (#4).
    let resumed: Session | null = null;
    if (opts.sessionId) {
        try {
            resumed = await manager.open(opts.sessionId);
        } catch {
            failEarly(format, `Session not found: ${opts.sessionId} (see \`${PRODUCT_NAME} sessions\`)`);
        }
    }
    const cwd = opts.cwd ?? resumed?.info.cwd ?? process.cwd();
    // No silent provider fallback — require an explicitly selected model.
    const modelId =
        opts.modelId ??
        resumed?.info.model ??
        getProjectModel(cwd) ??
        (settingsStore.get("defaultModel") as string | undefined);
    if (!modelId) {
        failEarly(
            format,
            `No model selected. Pass --model <provider/model>, or run ${PRODUCT_NAME} interactively and use /login + /provider first.`,
        );
    }
    const provider = (getActiveProvider() ?? parseModelId(modelId).provider) as ProviderId;
    const session = resumed ?? (await manager.create({ cwd, provider, model: modelId }));
    const tracker = new CostTracker();
    const emitter = asTurnEmitter(new EventEmitter());
    const abort = new AbortController();

    // The reporter owns every write to stdout/stderr. Turn-level stream errors
    // are emitted, not thrown (the turn winds down normally after one), so it
    // also records them — CI needs a nonzero exit rather than a clean 0 with an
    // error line buried in stderr.
    const reporter = createReporter(format);
    reporter.attach(emitter);
    const startedAt = Date.now();
    reporter.begin({ sessionId: session.id, model: modelId, cwd });

    process.on("SIGINT", () => abort.abort());

    // SessionStart hooks run in print mode too (Claude Code -p parity);
    // additionalContext is prepended to the one-shot prompt.
    const startHooks = await runHooks(
        "SessionStart",
        "startup",
        { session_id: session.id, transcript_path: session.path, source: "startup" },
        cwd,
    );
    // Through the emitter rather than straight to the streams, so the reporter
    // decides where it goes: a hook's terminal escape sequence written raw to
    // stdout would corrupt a JSON run's output.
    for (const m of startHooks.messages) emitter.emit("hook-message", m);
    for (const s of startHooks.terminalSequences) emitter.emit("hook-terminal-sequence", s);
    const userInput = startHooks.additionalContext ? `${startHooks.additionalContext}\n\n${opts.prompt}` : opts.prompt;

    // Connect MCP servers before the turn (same gate as the agent loop) so
    // their tools are available headlessly. Closed after the turn finishes.
    const mcpEnabled = isMcpEnabled();
    if (mcpEnabled) await getMcpManager().init(cwd);

    // Load extensions so their tools/middleware apply headlessly too. No-op
    // when none are installed. Inject a browser opener but no `ui`: any
    // api.ui call throws in print mode (interactive panels need a real session).
    getExtensionHost().setServices({ openExternal: (url) => openBrowser(url) });
    await getExtensionHost().init();

    await runTurn({
        session,
        modelId,
        userInput,
        cwd,
        abortSignal: abort.signal,
        tracker,
        emitter,
        // Plan is a per-session TUI mode — a one-shot run never starts in it.
        agent: resolveSavedAgent(settingsStore.get("agent") as string | undefined),
        // One-shot mode prints nothing after the response — skip the recap pass.
        recap: false,
        maxSteps: opts.maxSteps,
    });

    // The run is over, so the process is: kill anything bash left running.
    // Print mode never promotes a timed-out command to the background (no
    // panel to show it in), but the model can still ask for one explicitly
    // when the backgroundShells setting is on — and a one-shot run has no
    // later turn in which to notice it. Silent: the reporter owns both
    // streams, and a stray line would corrupt a JSON run's output.
    killAllBashChildren();

    if (mcpEnabled) await getMcpManager().close();
    await getExtensionHost().close();

    await runSessionEndHooks(session, cwd);

    reporter.end({
        ok: !reporter.errored,
        cost: tracker.sessionBreakdown(),
        durationMs: Date.now() - startedAt,
    });
    // Checkpoint + close the session DB so the -wal file doesn't linger.
    closeDb();
    // exitCode (not process.exit) so the streams flush before the process ends.
    if (reporter.errored) process.exitCode = 1;
}
