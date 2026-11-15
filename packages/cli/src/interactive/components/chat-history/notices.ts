import { Text } from "@notshekhar/loop-tui";
import type { BtwMeta, TeamTurnMeta } from "@notshekhar/loop-core";
import { theme } from "../../ui/theme";
import { formatTaskDuration } from "../../ui/tool-execution";
import { accent, accentTitle, dim, err, ok } from "../../ui/text";

// The words of the transcript's non-message rows — notices, cards, echoes,
// turn closers. ChatHistory decides where they go; this decides what they say.

/** A transcript row of text, indented one column like every other block. */
export function textRow(text: string): Text {
    return new Text(text, 1, 0);
}

/** `41s` under a minute, `1m23s` beyond — how a turn's length is said. */
function turnDuration(seconds: number): string {
    return seconds < 60 ? `${Math.round(seconds)}s` : formatTaskDuration(seconds * 1000);
}

export function turnCompletedLine(seconds: number): string {
    return theme.fg("turnSummary", `Turn completed in ${turnDuration(seconds)}.`);
}

export function turnFailedLine(seconds: number, reason: string): string {
    return err(`Turn failed in ${turnDuration(seconds)}: ${reason}`);
}

export function hookContextNotice(context: string): string {
    const lines = context.split("\n").length;
    return theme.fg("hookAccent", `session-start hook context attached (${lines} lines)`);
}

export function btwQuestionHeader(btw: BtwMeta): string {
    return (
        accent("↳ ") +
        accentTitle("Side question") +
        dim(` from “${btw.parentTitle}” · that chat never sees this thread · /btw back returns there`)
    );
}

/** A thread-team card's lines: a member's brief, or the mail it received. */
export function teamCardLines(team: TeamTurnMeta, text: string): string[] {
    return team.kind === "spawn" ? briefLines(team, text) : mailLines(team);
}

function briefLines(team: TeamTurnMeta, text: string): string[] {
    const from = team.from ? `"${team.from.title}"` : "the lead";
    const lines = [
        accent("⧉ ") + accentTitle(`Brief from ${from}`) + (team.title ? dim(` · this thread is "${team.title}"`) : ""),
    ];
    const brief = text.replace(
        /\n\n\(Brief from "[^"]*"\. Your thread is "[^"]*"\. Call report when you are done\.\)$/,
        "",
    );
    for (const line of brief.split("\n")) lines.push(`  ${line}`);
    return lines;
}

function mailLines(team: TeamTurnMeta): string[] {
    const lines: string[] = [];
    for (const mail of team.mail ?? []) {
        const head =
            mail.kind === "report"
                ? ok("✔ ") + accentTitle(`Report from "${mail.from.title}"`)
                : mail.kind === "update"
                  ? accent("⧉ ") + dim("Team update")
                  : accent("✉ ") + accentTitle(`Message from "${mail.from.title}"`);
        lines.push(head);
        for (const line of mail.text.trim().split("\n")) lines.push(`  ${dim(line)}`);
    }
    return lines;
}

/** An executed slash command: highlighted /name, dim args. */
export function commandEcho(text: string): string {
    const space = text.indexOf(" ");
    const cmd = space < 0 ? text : text.slice(0, space);
    const rest = space < 0 ? "" : text.slice(space);
    return accentTitle(cmd) + (rest ? dim(rest) : "");
}

/** Post-turn recap: dim `※ recap:`-labelled lines. */
export function recapBody(text: string): string {
    const lines = text.split("\n");
    lines.push("(disable recaps in /settings)");
    return lines.map((l, i) => dim(i === 0 ? `※ recap: ${l}` : `  ${l}`)).join("\n");
}
