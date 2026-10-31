/**
 * The parting line: how to get this conversation back.
 *
 * A session's id is the only handle on it, and until now it was never shown
 * anywhere you could copy it from once loop had exited — you had to go and
 * find it in `loop sessions`. Printing it on the way out means the command to
 * resume is already sitting in your scrollback the moment you want it, which
 * is exactly when you have just closed the thing you needed.
 */
import { getAppProfile } from "@notshekhar/loop-core";

/**
 * Write the resume command to stdout. Call AFTER the TUI has stopped — the
 * alternate screen is gone by then, so this lands in the terminal's own
 * scrollback and survives the exit.
 *
 * Silent when there is no session: an unsaved conversation (no model picked,
 * nothing sent) has no id to resume by, and printing a command that cannot
 * work is worse than printing nothing. Silent too when stdout is not a
 * terminal, so the line never lands in a pipe that expects only real output.
 */
export function printResumeHint(sessionId: string | undefined, out: NodeJS.WriteStream = process.stdout): void {
    if (!sessionId || !out.isTTY) return;
    out.write(`\nResume this session with:\n  ${getAppProfile().name} --session ${sessionId}\n`);
}
