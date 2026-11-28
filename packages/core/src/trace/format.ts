/** Number formatting for the trace's server-rendered text. The client
 * script (client.ts) carries the same rules for what it draws itself. */

// Dollars are shared formatting now; re-exported so the trace's imports stay put.
export { fmtUsd } from "../format";

export function fmtMs(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s ? `${m} min ${s} s` : `${m} min`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
