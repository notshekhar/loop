/**
 * /notes — things to say later, kept with this session and nowhere else.
 *
 * `/notes` opens the list: Enter on a note offers submit (send it as your
 * next message, which takes it off the list) or delete; the list also adds a
 * note and removes them all. `/notes <text>` and `/note <text>` add one
 * without opening anything, so a thought can be parked mid-turn.
 */
import {
    addNote,
    clearNotes,
    formatDuration,
    listNotes,
    takeNote,
    type CommandContext,
    type SessionNote,
} from "@notshekhar/loop-core";
import type { SelectItem } from "@notshekhar/loop-tui";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { dim } from "../ui/text";

type NotesHandlers = Pick<CommandContext, "manageNotes">;

const ADD = "\x00add";
const CLEAR = "\x00clear";

const notesCount = (n: number): string => `${n} note${n === 1 ? "" : "s"}`;

/** One line of a note for a list row; the picker truncates to the width. */
function noteLabel(note: SessionNote): string {
    return note.text.replace(/\s+/g, " ").trim();
}

function noteItems(notes: SessionNote[]): SelectItem[] {
    const now = Date.now();
    return notes.map((n) => ({
        value: n.id,
        label: noteLabel(n),
        description: `${formatDuration(now - n.createdAt)} ago`,
    }));
}

export function createNotesHandlers(state: AppState, deps: AppDeps): NotesHandlers {
    const { tui, history, selectOnce, searchOnce, promptOnce } = deps;

    const say = (text: string) => {
        history.addSystem(text);
        tui.requestRender();
    };

    /** The notes of the session on screen; a session not saved yet has none. */
    const current = (): SessionNote[] => (state.session ? listNotes(state.session.id) : []);

    /** Adding is what saves a new session: its notes need a session to belong to. */
    async function add(text: string): Promise<void> {
        const session = await deps.ensureSession();
        addNote(session.id, text);
        say(dim(`note saved · ${notesCount(listNotes(session.id).length)} in this session · /notes to open`));
    }

    async function confirmClear(count: number): Promise<boolean> {
        const pick = await selectOnce(
            [
                { value: "yes", label: `remove all ${notesCount(count)}` },
                { value: "no", label: "cancel" },
            ],
            "Remove every note in this session?",
        );
        return pick?.value === "yes";
    }

    /** Submit sends the note as if typed — queued behind a running turn, like typing. */
    function submit(sessionId: string, noteId: string): void {
        const note = takeNote(sessionId, noteId);
        if (!note) return say(dim("That note is already gone."));
        deps.editor.onSubmit?.(note.text);
    }

    /** Submit or delete one note. Returns true once the panel should close. */
    async function actOn(note: SessionNote): Promise<boolean> {
        const sessionId = state.session!.id;
        const choice = await selectOnce(
            [
                { value: "submit", label: "submit", description: "send it as your next message" },
                { value: "delete", label: "delete", description: "remove it from this session" },
            ],
            noteLabel(note),
        );
        if (choice?.value === "submit") {
            submit(sessionId, note.id);
            return true;
        }
        if (choice?.value === "delete") takeNote(sessionId, note.id);
        return false;
    }

    async function openPanel(): Promise<void> {
        let lastIndex = 0;
        while (true) {
            const notes = current();
            const items: SelectItem[] = [
                ...noteItems(notes),
                { value: ADD, label: "+ add note…" },
                ...(notes.length ? [{ value: CLEAR, label: "remove all notes" }] : []),
            ];
            const title = notes.length ? `Notes · ${notes.length}` : "Notes · none yet";
            const pick = await searchOnce(items, title, { initialIndex: Math.min(lastIndex, items.length - 1) });
            if (!pick) return;
            lastIndex = items.findIndex((i) => i.value === pick.value);

            if (pick.value === ADD) {
                const text = (await promptOnce("New note")).trim();
                if (text) await add(text);
                continue;
            }
            if (pick.value === CLEAR) {
                if (await confirmClear(notes.length)) say(dim(`removed ${notesCount(clearNotes(state.session!.id))}`));
                continue;
            }
            const note = notes.find((n) => n.id === pick.value);
            if (note && (await actOn(note))) return;
        }
    }

    return {
        async manageNotes(args: string) {
            const text = args.trim();
            if (text) await add(text);
            else await openPanel();
        },
    };
}
