import type { Entry } from "../types";

/** Keep the task's opening and its latest outcome; cap individual tool-heavy entries. */
export function conversationExcerpt(entries: Entry[]): string {
    const parts = entries.flatMap((entry): string[] => {
        switch (entry.type) {
            case "message": {
                const content = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
                return [
                    `[${entry.role}]\n${content.length > 8_000 ? content.slice(0, 4_000) + "\n[entry excerpted]\n" + content.slice(-4_000) : content}`,
                ];
            }
            case "compact":
                return [`[earlier context]\n${entry.handoff ?? entry.summary ?? ""}`.slice(0, 8_000)];
            case "branch-summary":
                return [`[branch summary]\n${entry.summary}`.slice(0, 8_000)];
            case "subagent":
                return [`[subagent result]\n${entry.result}`.slice(0, 8_000)];
            default:
                return [];
        }
    });
    const text = parts.join("\n\n");
    return text.length <= 60_000
        ? text
        : `${text.slice(0, 12_000)}\n\n[middle of conversation omitted]\n\n${text.slice(-47_000)}`;
}
