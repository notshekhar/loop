/**
 * A team entry (a member's brief, mail between threads — packages/core/src/
 * teams) as the transcript part a client draws. Shared by history.ts (saved
 * entries) and reduce.ts (the live stream), and runtime-import-free like the
 * rest of transcript/.
 */
import type { TeamPart } from "./types";

/** The `team` field of a saved user entry (packages/core/src/teams/runtime.ts TeamTurnMeta). */
export interface TeamEntryMeta {
    readonly kind?: string;
    readonly teamId?: string;
    readonly from?: { id: string; title: string };
    readonly title?: string;
    readonly mail?: readonly {
        id: number;
        from: { id: string; title: string };
        kind: string;
        text: string;
        ts: number;
    }[];
    readonly midTurn?: boolean;
}

/** A team entry as the card its transcript part is — null when the meta is unusable. */
export function teamPartOf(meta: TeamEntryMeta | undefined, text: string): TeamPart | null {
    if (!meta || (meta.kind !== "spawn" && meta.kind !== "mail") || typeof meta.teamId !== "string") return null;
    return {
        type: "data-team",
        data: {
            kind: meta.kind,
            teamId: meta.teamId,
            ...(meta.from ? { from: { id: meta.from.id, title: meta.from.title } } : {}),
            ...(meta.title ? { title: meta.title } : {}),
            ...(meta.kind === "spawn" ? { text } : {}),
            ...(meta.mail
                ? {
                      mail: meta.mail.map((m) => ({
                          id: m.id,
                          from: { id: m.from.id, title: m.from.title },
                          kind: m.kind === "report" || m.kind === "update" ? m.kind : "message",
                          text: m.text,
                          ts: m.ts,
                      })),
                  }
                : {}),
            ...(meta.midTurn ? { midTurn: true } : {}),
        },
    };
}
