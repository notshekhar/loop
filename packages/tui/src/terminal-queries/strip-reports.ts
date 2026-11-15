import { COLOR_SCHEME_REPORT_PREFIX, OSC11_REPORT_PREFIX } from "../terminal-colors";

export interface ReportHandlers {
    onBackgroundColor(report: string): void;
    onColorScheme(report: string): void;
}

/**
 * Strip every terminal REPORT out of an input chunk — the OSC 11
 * background colour and the `CSI ? 997 ; n` colour-scheme report — and
 * route each to its handler.
 *
 * Both are removed unconditionally: whether or not a query is still
 * pending, and wherever in the chunk they sit. Neither can ever be
 * something a person typed, and letting one through is not a harmless
 * stray character — an OSC 11 reply ENDS IN BEL, which is ctrl+g.
 */
export function stripTerminalReports(data: string, handlers: ReportHandlers): string {
    if (!data.includes("\x1b")) return data;
    let rest = data;
    let out = "";
    while (rest.length > 0) {
        const esc = rest.indexOf("\x1b");
        if (esc === -1) {
            out += rest;
            break;
        }
        out += rest.slice(0, esc);
        rest = rest.slice(esc);
        const osc = rest.match(OSC11_REPORT_PREFIX);
        if (osc) {
            handlers.onBackgroundColor(osc[0]);
            rest = rest.slice(osc[0].length);
            continue;
        }
        const scheme = rest.match(COLOR_SCHEME_REPORT_PREFIX);
        if (scheme) {
            handlers.onColorScheme(scheme[0]);
            rest = rest.slice(scheme[0].length);
            continue;
        }
        out += rest[0];
        rest = rest.slice(1);
    }
    return out;
}
