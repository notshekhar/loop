/**
 * The preview half of importing another agent's chat (the chat-import
 * extension reads it; this shows it and asks).
 *
 * The chat is drawn in the transcript through the same replay a resumed
 * session goes through, so what the preview shows is exactly what saving
 * gives. Then a menu takes the input box's place: Save makes it a new session
 * in this folder and switches to it; Discard (or Esc) puts the transcript
 * back as it was. Nothing touches the database until Save.
 */
import type { CommandContext, ImportPreview } from "@notshekhar/loop-core";
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

function messageCount(chat: ImportPreview): number {
    return chat.entries.filter((e) => e.type === "message" && e.role !== "tool").length;
}

export function importChoices(cwd: string): SelectItem[] {
    return [
        { value: SAVE, label: "Save", description: `as a new loop session in ${cwd}` },
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
        renderBranchEntries(chat.entries, PREVIEW_SESSION_ID, history, state.modelId);
        tui.requestRender();
    }

    async function save(chat: ImportPreview): Promise<void> {
        const session = await deps.manager.create({ cwd: state.cwd, provider: state.provider, model: state.modelId });
        // A copy: the session stamps ids and parents onto what it appends.
        await session.appendAll(structuredClone(chat.entries));
        await session.setName(chat.title);
        await resumeSessionById(state, deps, session.id);
        history.addSystem(`Saved the ${chat.source} chat as session ${session.id} — carry on from here.`);
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
            const choice = await deps.selectOnce(importChoices(state.cwd), `Import “${chat.title}”?`);
            if (choice?.value === SAVE) await save(chat);
            else discard(chat);
        },
    };
}
