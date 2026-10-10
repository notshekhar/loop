/**
 * Shared human-readable number formatting.
 *
 * The token formatter lived in five places (the status line, the statusline
 * extension's layouts, /context, /steak, the Telegram renderer) and every copy
 * stopped at `M` — so a billion tokens rendered as "1000M" and just kept
 * counting up from there. Consolidated here so the tiers can't disagree again,
 * and so the next one added lands everywhere at once.
 */

/**
 * Tokens as a compact count: `842`, `9.4k`, `183k`, `2.3M`, `412M`, `1.4B`, `2.1T`.
 *
 * Each magnitude shows one decimal for its first order (where the digit
 * carries real information: 2.3M is meaningfully more than 2.0M) and rounds
 * beyond it (where it doesn't: nobody needs 412.4M). Below 1000T every
 * result stays four characters or fewer, which is what lets it sit in a status
 * line without moving anything around it.
 */
export function formatTokens(n: number): string {
    if (!Number.isFinite(n)) return "0";
    const v = Math.max(0, n);
    if (v < 1_000) return String(Math.round(v));
    if (v < 10_000) return `${(v / 1_000).toFixed(1)}k`;
    // Each rounding tier ends at 999.5 of its unit, NOT at the unit itself:
    // rounding 999_600 gives "1000k", which is the same failure to roll over
    // that left a billion tokens reading as "1000M". Handing those to the tier
    // above is what actually makes the carry work.
    if (v < 999_500) return `${Math.round(v / 1_000)}k`;
    if (v < 10_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v < 999_500_000) return `${Math.round(v / 1_000_000)}M`;
    if (v < 10_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
    if (v < 999_500_000_000) return `${Math.round(v / 1_000_000_000)}B`;
    if (v < 10_000_000_000_000) return `${(v / 1_000_000_000_000).toFixed(1)}T`;
    return `${Math.round(v / 1_000_000_000_000)}T`;
}
