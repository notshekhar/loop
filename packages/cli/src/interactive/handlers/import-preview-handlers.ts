/**
 * The preview half of importing another agent's chat (the chat-import
 * extension reads and prices it; this shows it and asks).
 *
 * The chat is drawn in the transcript through the same replay a resumed
 * session goes through, so what the preview shows is exactly what saving
 * gives, with what the chat cost under it. Then a menu takes the input box's
 * place: Save makes it a new session in this folder, files its calls in the
 * cost ledger, and switches to it; Discard (or Esc) puts the transcript back
 * as it was. Nothing touches the database until Save.
 *
 * A chat imported before isn't saved again — that would bill its calls to the
 * ledger twice — the menu opens the session it became instead.
 */
import { fmtUsd, formatTokens, recordChatImport, type CommandContext, type ImportPreview } from "@notshekhar/loop-core";
import type { SelectItem } from "@notshekhar/loop-tui";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { renderBranchEntries } from "../replay";
import { dim } from "../ui/text";
import { rejectWhileBusy, replayCurrentBranch } from "./shared";
import { resumeSessionById } from "./session-handlers";

type ImportPreviewHandlers = Pick<CommandContext, "previewImport">;

/** The id the preview is replayed under — never a real session's. */
const PREVIEW_SESSION_ID = "import-preview";

const SAVE = "save";
const OPEN = "open";

function messageCount(chat: ImportPreview): number {
    return chat.entries.filter((e) => e.type === "message" && e.role !== "tool").length;
}

/** "~1.2M tokens in · 9.4k out · ~$3.12" — the `~` when any of it is estimated. */
export function costLine(chat: ImportPreview): string {
    const { cost } = chat;
    const about = cost.approximate ? "~" : "";
    return `${about}${formatTokens(cost.inputTokens)} tokens in · ${formatTokens(cost.outputTokens)} out · ${about}${fmtUsd(cost.usd)}`;
}

export function importChoices(cwd: string, chat: ImportPreview): SelectItem[] {
    if (chat.importedAs) {
        return [
            { value: OPEN, label: "Open it", description: `already imported as session ${chat.importedAs}` },
            { value: "discard", label: "Discard", description: "nothing changes" },
        ];
    }
    return [
        {
            value: SAVE,
            label: "Save",
            description: `as a new loop session in ${cwd} · ${fmtUsd(chat.cost.usd)} into the cost ledger`,
        },
        { value: "discard", label: "Discard", description: "nothing is saved" },
    ];
}

export function createImportPreviewHandlers(state: AppState, deps: AppDeps): ImportPreviewHandlers {
    const { history, tui } = deps;

    function showPreview(chat: ImportPreview): void {
        history.reset();
        history.addSystem(
            `Preview · ${chat.source} chat “${chat.title}” · ${messageCount(chat)} messages ${dim("· not saved yet")}`,
        );
        // Above the chat, not under it: an open menu covers the transcript's last row.
        history.addSystem(
            `Cost · ${costLine(chat)}${chat.cost.byModel.length ? dim(` · ${chat.cost.byModel.join(" · ")}`) : ""}`,
        );
        renderBranchEntries(chat.entries, PREVIEW_SESSION_ID, history, state.modelId);
        tui.requestRender();
    }

    async function save(chat: ImportPreview): Promise<void> {
        const session = await deps.manager.create({ cwd: state.cwd, provider: state.provider, model: state.modelId });
        // A copy: the session stamps ids and parents onto what it appends.
        await session.appendAll(structuredClone(chat.entries));
        await session.setName(chat.title);
        recordChatImport({
            source: chat.origin.source,
            chatId: chat.origin.chatId,
            sessionPub: session.id,
            cwd: state.cwd,
            calls: chat.cost.calls,
        });
        await resumeSessionById(state, deps, session.id);
        history.addSystem(
            `Saved the ${chat.source} chat as session ${session.id} — ${costLine(chat)} is in the cost ledger. Carry on from here.`,
        );
        tui.requestRender();
    }

    async function open(chat: ImportPreview, sessionPub: string): Promise<void> {
        await resumeSessionById(state, deps, sessionPub);
        history.addSystem(dim(`Opened the session this ${chat.source} chat was imported as.`));
        tui.requestRender();
    }

    function discard(chat: ImportPreview): void {
        replayCurrentBranch(state, deps);
        history.addSystem(dim(`Discarded the ${chat.source} chat — nothing was saved.`));
        tui.requestRender();
    }

    return {
        async previewImport(chat) {
            if (rejectWhileBusy(state, deps)) return;
            showPreview(chat);
            const choice = await deps.selectOnce(importChoices(state.cwd, chat), `Import “${chat.title}”?`);
            if (choice?.value === SAVE) await save(chat);
            else if (choice?.value === OPEN && chat.importedAs) await open(chat, chat.importedAs);
            else discard(chat);
        },
    };
}
