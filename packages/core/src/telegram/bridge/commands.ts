/** Slash commands typed in the paired chat: the menu, aliases, and one handler each. */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCT_NAME } from "../../brand";
import { INIT_PROMPT } from "../../commands";
import { THINKING_LEVELS, type ThinkingLevel } from "../../agent/thinking";
import type { ContextReport } from "../../agent/context-report";
import type { SteakGrid } from "../../agent/steak";
import type { CostStats } from "../../agent/cost";
import type { CostBreakdown } from "../../types";
import type { BotCommandDef } from "../api";
import { escapeHtml, formatContext, formatCost, formatSteak, truncate } from "../render";
import { extensionsKeyboard, providerKeyboard, settingsKeyboard, thinkingKeyboard } from "../menus";
import type { BridgeContext } from "./context";
import { authorizedModels, sessionsPage } from "./queries";

/** The command menu Telegram shows natively (setMyCommands). Everything the
 * RPC surface can honestly do remotely — panel commands become inline-
 * keyboard menus, terminal-only commands (/ui, /hotkeys, /copy…) and
 * security-sensitive ones (/login, /install) are deliberately absent. */
export const BOT_COMMANDS: BotCommandDef[] = [
    { command: "new", description: "Start a new session" },
    { command: "sessions", description: "List sessions and switch" },
    { command: "cancel", description: "Cancel the running turn and drop the queue" },
    { command: "queue", description: "Queue a message for after this turn (no args: list, clear: empty it)" },
    { command: "model", description: "Pick provider and model" },
    { command: "thinking", description: "Set reasoning effort" },
    { command: "settings", description: "Toggle settings" },
    { command: "cost", description: "Cost breakdown" },
    { command: "context", description: "Context window usage" },
    { command: "steak", description: "Token usage heatmap" },
    { command: "session", description: "Current session info" },
    { command: "name", description: "Rename the session: /name <text>" },
    { command: "compact", description: "Compact the session context" },
    { command: "export", description: "Export session transcript file" },
    { command: "extensions", description: "Enable or disable extensions" },
    { command: "cd", description: "Set working dir for new sessions" },
    { command: "status", description: "Bridge status" },
    { command: "init", description: "Analyze the repo, write AGENTS.md" },
    { command: "help", description: "List commands" },
];

/** Aliases accepted in chat but kept out of the menu to reduce noise. */
const COMMAND_ALIASES: Record<string, string> = {
    clear: "new",
    resume: "sessions",
    rename: "name",
    stop: "cancel",
    effort: "thinking",
    cwd: "cd",
    provider: "model",
    start: "start",
    enqueue: "queue",
    queued: "queue",
};

type CommandHandler = (ctx: BridgeContext, args: string) => Promise<void>;

/** Parse and run one slash command (anything but /start, which pairs). */
export async function dispatchCommand(ctx: BridgeContext, raw: string): Promise<void> {
    const m = raw.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/);
    const name = m?.[1]?.toLowerCase() ?? "";
    const args = m?.[2]?.trim() ?? "";
    const resolved = COMMAND_ALIASES[name] ?? name;
    if (resolved !== "start" && (BOT_COMMANDS.some((c) => c.command === resolved) || resolved in COMMAND_ALIASES)) {
        await runCommand(ctx, resolved, args);
    } else {
        await ctx.chat.replySafe(`unknown command /${name} — /help lists what works here`);
    }
}

async function runCommand(ctx: BridgeContext, name: string, args: string): Promise<void> {
    const handler = COMMANDS[name] as CommandHandler | undefined;
    if (handler) await handler(ctx, args);
    else await ctx.chat.replySafe(`unknown command /${name}`);
}

/** Reply with aligned `label  value` rows in a monospace block. */
function replyTable(ctx: BridgeContext, lines: string[]): Promise<void> {
    return ctx.chat.replySafe(`<pre>${escapeHtml(lines.join("\n"))}</pre>`, { html: true });
}

async function help({ chat }: BridgeContext): Promise<void> {
    const lines = BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`);
    lines.push(
        "",
        "plain messages go to the agent; photos are attached as images",
        "sending a message while it's working INTERRUPTS the turn and runs yours instead",
        "use /queue <message> to run it after the current turn instead of interrupting",
    );
    await chat.replySafe(lines.join("\n"));
}

async function newSession({ chat, session }: BridgeContext): Promise<void> {
    await session.startFresh();
    // Name the model the new session will run on. On a phone the
    // picker is several taps away, and a session started on the
    // wrong (or an unexpectedly inherited) model is only noticed
    // after it has already answered.
    const startingModel = session.activeModel();
    await chat.replySafe(
        startingModel
            ? `new session on <b>${escapeHtml(startingModel)}</b> — send a message to start it`
            : "new session — send a message to start it (no model set; /model to pick one)",
        { html: true },
    );
}

async function sessions({ chat, peer }: BridgeContext): Promise<void> {
    const page = await sessionsPage(peer, 0);
    if (!page) {
        await chat.replySafe("no sessions yet");
        return;
    }
    await chat.replySafe(page.title, { keyboard: page.keyboard });
}

async function sessionInfo(ctx: BridgeContext): Promise<void> {
    const { chat, peer, session } = ctx;
    if (!session.sessionId) {
        await chat.replySafe("no active session — send a message or /sessions to pick one");
        return;
    }
    const h = await peer.call<{
        info: { id: string; cwd: string; provider: string; model: string };
        name?: string;
        entries: unknown[];
        running: boolean;
    }>("session.history", { sessionId: session.sessionId });
    await replyTable(ctx, [
        `id        ${h.info.id}`,
        `name      ${h.name || "(unnamed)"}`,
        `model     ${session.activeModel() ?? h.info.model}`,
        `cwd       ${h.info.cwd}`,
        `entries   ${h.entries.length}`,
        `running   ${h.running ? "yes" : "no"}`,
    ]);
}

async function rename({ chat, peer, session }: BridgeContext, args: string): Promise<void> {
    if (!args) {
        await chat.replySafe("usage: /name <new name>");
        return;
    }
    if (!session.sessionId) {
        await chat.replySafe("no active session to rename");
        return;
    }
    await peer.call("session.rename", { sessionId: session.sessionId, name: args });
    await chat.replySafe(`renamed: ${args}`);
}

async function cancel({ chat, peer, session }: BridgeContext): Promise<void> {
    // Stop everything: the running turn AND anything waiting, so
    // /cancel can't be followed by a surprise queued turn.
    const dropped = session.queue.length;
    session.queue = [];
    if (!session.sessionId || !session.live) {
        await chat.replySafe(dropped ? `nothing running — dropped ${dropped} queued` : "nothing to cancel");
        return;
    }
    await peer.call("session.cancel", { sessionId: session.sessionId });
    await chat.replySafe(dropped ? `cancelled · dropped ${dropped} queued` : "cancelled");
}

async function queue(ctx: BridgeContext, args: string): Promise<void> {
    const sub = args.trim();
    if (sub === "clear") await clearQueue(ctx);
    else if (!sub) await listQueue(ctx);
    else await addToQueue(ctx, sub);
}

async function clearQueue({ chat, session }: BridgeContext): Promise<void> {
    const n = session.queue.length;
    session.queue = [];
    await chat.replySafe(n ? `queue cleared (${n} dropped)` : "queue was already empty");
}

async function listQueue({ chat, session }: BridgeContext): Promise<void> {
    if (!session.queue.length) {
        await chat.replySafe("queue is empty — /queue <message> adds one");
        return;
    }
    const lines = session.queue.map((q, i) => `${i + 1}. ${truncate(q.text || "(image)", 60)}`);
    await chat.replySafe(`<b>queued</b>\n${escapeHtml(lines.join("\n"))}`, { html: true });
}

async function addToQueue({ chat, session }: BridgeContext, text: string): Promise<void> {
    session.enqueuePrompt(text);
    // With nothing running the queue drains immediately, so say what
    // actually happened rather than claiming it's waiting.
    if (!session.live) {
        await chat.replySafe("nothing running — starting it now");
        await session.drainQueue();
        return;
    }
    await chat.replySafe(`queued (position ${session.queue.length}) — runs after this turn`);
}

async function compact({ chat, peer, session }: BridgeContext): Promise<void> {
    if (!session.sessionId) {
        await chat.replySafe("no active session to compact");
        return;
    }
    const r = await peer.call<{ tokensBefore: number; tokensAfter?: number }>("session.compact", {
        sessionId: session.sessionId,
    });
    await chat.replySafe(
        r.tokensBefore > 0 ? `compacted: ~${r.tokensBefore} → ~${r.tokensAfter ?? 0} tokens` : "nothing to compact yet",
    );
}

async function model({ chat, peer, session }: BridgeContext, args: string): Promise<void> {
    const models = await authorizedModels(peer);
    if (!models.length) {
        await chat.replySafe(
            `no providers are logged in. Run \`${PRODUCT_NAME} login\` on your computer, then /model here.`,
        );
        return;
    }
    if (!args) {
        await chat.replySafe("pick a provider", { keyboard: providerKeyboard(models) });
        return;
    }
    const hit = models.find((m) => m.id === args || m.id.endsWith(`/${args}`));
    if (!hit) {
        await chat.replySafe(`unknown or unavailable model: ${args}`);
        return;
    }
    session.selectModel(hit);
    await chat.replySafe(`model set: ${hit.id}`);
}

async function thinking({ chat, session }: BridgeContext, args: string): Promise<void> {
    if (!args) {
        await chat.replySafe("pick a thinking level", {
            keyboard: thinkingKeyboard(THINKING_LEVELS, session.thinking),
        });
        return;
    }
    if (!THINKING_LEVELS.includes(args as ThinkingLevel)) {
        await chat.replySafe(`thinking level must be one of: ${THINKING_LEVELS.join(", ")}`);
        return;
    }
    session.thinking = args as ThinkingLevel;
    await chat.replySafe(`thinking: ${args}`);
}

async function settings({ chat, peer }: BridgeContext): Promise<void> {
    const rows = await peer.call<{ key: string; label: string; value: boolean }[]>("settings.list");
    await chat.replySafe("settings — tap to toggle", { keyboard: settingsKeyboard(rows) });
}

async function extensions({ chat, peer }: BridgeContext): Promise<void> {
    const rows = await peer.call<{ name: string; enabled: boolean }[]>("extension.list");
    if (!rows.length) {
        await chat.replySafe("no extensions installed");
        return;
    }
    await chat.replySafe("extensions — tap to toggle", { keyboard: extensionsKeyboard(rows) });
}

async function cost({ chat, peer, session }: BridgeContext): Promise<void> {
    const stats = await peer.call<CostStats>("cost.stats", { cwd: session.cwd });
    let current: CostBreakdown | undefined;
    if (session.sessionId) {
        try {
            current = await peer.call<CostBreakdown>("cost.session", { sessionId: session.sessionId });
        } catch {}
    }
    await chat.replySafe(formatCost(stats, current), { html: true });
}

async function context({ chat, peer, session }: BridgeContext): Promise<void> {
    const report = await peer.call<ContextReport>("context.report", {
        ...(session.sessionId ? { sessionId: session.sessionId } : { cwd: session.cwd }),
        model: session.activeModel() ?? undefined,
    });
    await chat.replySafe(formatContext(report), { html: true });
}

async function steak({ chat, peer }: BridgeContext, args: string): Promise<void> {
    const year = /^\d{4}$/.test(args) ? Number(args) : undefined;
    const grid = await peer.call<SteakGrid>("usage.steak", year ? { year } : {});
    await chat.replySafe(formatSteak(grid), { html: true });
}

async function exportSession({ chat, peer, session }: BridgeContext): Promise<void> {
    if (!session.sessionId) {
        await chat.replySafe("no active session to export");
        return;
    }
    const h = await peer.call<{ entries: unknown[] }>("session.history", { sessionId: session.sessionId });
    const jsonl = h.entries.map((e) => JSON.stringify(e)).join("\n");
    if (!jsonl) {
        // Telegram rejects a zero-byte document upload.
        await chat.replySafe("nothing to export yet — this session has no entries");
        return;
    }
    await chat.sendDocument(`${session.sessionId}.jsonl`, jsonl, `${h.entries.length} entries`);
}

async function cd({ chat, session }: BridgeContext, args: string): Promise<void> {
    if (!args) {
        await chat.replySafe(`cwd: ${session.cwd}`);
        return;
    }
    const target = resolve(session.cwd, args);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
        await chat.replySafe(`not a directory: ${target}`);
        return;
    }
    session.cwd = target;
    await chat.replySafe(`cwd: ${target} (applies to new sessions — /new)`);
}

async function status(ctx: BridgeContext): Promise<void> {
    const { session } = ctx;
    await replyTable(ctx, [
        `session   ${session.sessionId ?? "(none)"}`,
        `model     ${session.activeModel() ?? "(unset)"}`,
        `thinking  ${session.thinking ?? "(default)"}`,
        `cwd       ${session.cwd}`,
        `turn      ${session.isTurnRunning() ? "running" : "idle"}`,
        `queued    ${session.queue.length}`,
    ]);
}

async function init({ session }: BridgeContext): Promise<void> {
    await session.sendPrompt(INIT_PROMPT);
}

const COMMANDS: Record<string, CommandHandler> = {
    help,
    new: newSession,
    sessions,
    session: sessionInfo,
    name: rename,
    cancel,
    queue,
    compact,
    model,
    thinking,
    settings,
    extensions,
    cost,
    context,
    steak,
    export: exportSession,
    cd,
    status,
    init,
};
