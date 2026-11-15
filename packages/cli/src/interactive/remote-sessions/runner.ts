/**
 * What typing into a remote session does: a message goes to its host, and
 * only the commands that make sense away from this machine run.
 */
import { formatError } from "../format-error";
import type { SessionSlot } from "../slots";
import { dim, warn } from "../ui/text";
import type { RemoteState } from "./state";
import { beginTurn, endTurn } from "./turn";

/** Commands that make sense while another machine's session is on screen. */
const REMOTE_OK = new Set(["hosts", "rc", "help", "exit", "quit", "hotkeys", "theme", "copy"]);
/** Commands that leave for a session on this machine first, then run. */
const GO_LOCAL = new Set(["new", "clear", "resume", "sessions"]);

/** The slash command `text` names, when it names a registered one. */
function commandIn(state: RemoteState, text: string): string | null {
    if (!text.startsWith("/")) return null;
    const space = text.indexOf(" ");
    const command = space < 0 ? text.slice(1) : text.slice(1, space);
    return state.host.commands.has(command) ? command : null;
}

/** A command typed into a remote session: leave for this machine, refuse, or run. */
async function runCommand(state: RemoteState, slot: SessionSlot, text: string, command: string): Promise<void> {
    const { deps, tui, commands, ctx } = state.host;
    const link = slot.remote!;
    slot.history.addCommand(text);
    if (GO_LOCAL.has(command)) {
        // A fresh local session to land in; /resume then fills it.
        await deps.sessions.openNew();
        if (command === "new" || command === "clear") return;
    } else if (!REMOTE_OK.has(command)) {
        slot.history.addSystem(
            warn(`/${command} acts on this machine — this session is on ${link.host.label}. `) +
                dim("/hosts → This machine to go back."),
        );
        tui.requestRender();
        return;
    }
    try {
        await commands.run(text, ctx);
    } catch (e) {
        deps.history.addError(formatError(e));
    }
    tui.requestRender();
}

/** A message typed into a remote session: shown here, run there. */
async function sendMessage(state: RemoteState, slot: SessionSlot, text: string): Promise<void> {
    const link = slot.remote!;
    slot.history.addUser(text);
    state.host.roster.depsFor(slot).scrollTranscriptToEnd();
    if (!link.title) link.title = text.split("\n")[0]!.slice(0, 80);
    state.sentHere.add(slot);
    beginTurn(state, slot);
    state.host.tui.requestRender();
    try {
        await link.client.call("session.send", { sessionId: link.sessionId, input: text, model: link.model });
    } catch (e) {
        const turn = state.turns.get(slot);
        turn?.errors.push(e);
        endTurn(state, slot);
    }
}

/** The runner the roster uses for a slot showing another machine's session. */
export const remoteRunner =
    (state: RemoteState) =>
    (slot: SessionSlot) =>
    async (raw: string): Promise<void> => {
        const { tui } = state.host;
        const text = raw.trim();
        if (!text) return;
        const command = commandIn(state, text);
        if (slot.busy && !(command !== null && (GO_LOCAL.has(command) || command === "hosts"))) {
            slot.queue.push(text);
            state.host.roster.depsFor(slot).renderPending();
            tui.requestRender();
            return;
        }
        if (text.startsWith("!")) {
            slot.history.addSystem(warn(`! runs on this machine — this session is on ${slot.remote!.host.label}`));
            tui.requestRender();
            return;
        }
        if (command !== null) return runCommand(state, slot, text, command);
        await sendMessage(state, slot, text);
    };
