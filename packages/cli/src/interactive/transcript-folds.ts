/**
 * Which transcript entries fold into a run of tool calls, and which stand the
 * run's header in for the rest.
 *
 * Pure arithmetic over a list of classified entries — grok-build's verb-run
 * scan (`scrollback/state/groups.rs`, `verb_group.rs`), kept to the parts loop
 * uses — so the rules can be stated and tested without a component in sight.
 * The transcript asks it one question per entry each render: are you drawn as
 * yourself, hidden inside a closed run, or as a run's header?
 *
 * A run is a stretch of consecutive tool calls, and ONE row while closed
 * (`◈ Read 3 files, Ran 2 commands`):
 *   - a collapsed call is a MEMBER; it counts and joins;
 *   - a call that keeps its own rows — one the user opened, or an action still
 *     running — is TRANSPARENT: it neither joins nor splits the run, so
 *     opening one call never dissolves the group around it;
 *   - anything else — a prompt, a response, a thought, a system line — BREAKS
 *     the run.
 * One member is enough to fold (grok's `RunScan::folds`), so a second call
 * joins an existing header instead of a row collapsing under you.
 */

/** How one entry takes part in a run (grok's `RunStep`, minus thoughts). */
export type RunStep =
    | { readonly kind: "member"; readonly running: boolean; readonly failed: boolean }
    | { readonly kind: "transparent" }
    | { readonly kind: "break" };

/** A run of calls, as entry indices (`end` exclusive). */
export interface FoldSpan {
    readonly start: number;
    readonly end: number;
    /** Members counted — transparent entries inside the run are not. */
    readonly members: number;
    readonly running: boolean;
    readonly failed: number;
    readonly open: boolean;
}

/** How an entry is drawn this render. */
export type FoldRole =
    | { readonly kind: "self" }
    | { readonly kind: "hidden" }
    /** The entry draws the run's header — alone while it is closed, above its
     * own rows once it is open. */
    | { readonly kind: "header"; readonly span: FoldSpan };

export interface FoldLayout {
    readonly spans: readonly FoldSpan[];
    readonly roles: readonly FoldRole[];
}

/**
 * Find every run and give each entry its role. `isOpen(start, end)` says
 * whether the user opened the run covering those entries.
 */
export function computeFolds(steps: readonly RunStep[], isOpen: (start: number, end: number) => boolean): FoldLayout {
    const spans = scanRuns(steps, isOpen);
    return { spans, roles: project(steps, spans) };
}

/**
 * Maximal runs, each anchored on a member (grok's `scan_run_forward`). A run
 * ends one past its last MEMBER, so a trailing transparent entry — an action
 * still running at the end of the turn — stays outside it, as its own row.
 */
function scanRuns(steps: readonly RunStep[], isOpen: (start: number, end: number) => boolean): FoldSpan[] {
    const spans: FoldSpan[] = [];
    let i = 0;
    while (i < steps.length) {
        if (steps[i].kind !== "member") {
            i++;
            continue;
        }
        let members = 0;
        let failed = 0;
        let running = false;
        let end = i;
        let j = i;
        for (; j < steps.length; j++) {
            const step = steps[j];
            if (step.kind === "break") break;
            if (step.kind === "member") {
                members++;
                if (step.failed) failed++;
                if (step.running) running = true;
                end = j + 1;
            }
        }
        spans.push({ start: i, end, members, running, failed, open: isOpen(i, end) });
        i = j;
    }
    return spans;
}

/** Turn runs into a role per entry (grok's `project_verb_run`). */
function project(steps: readonly RunStep[], spans: readonly FoldSpan[]): FoldRole[] {
    const roles: FoldRole[] = steps.map(() => ({ kind: "self" }));
    for (const span of spans) {
        roles[span.start] = { kind: "header", span };
        if (span.open) continue;
        // Members hide behind the header; transparent entries keep their rows.
        for (let k = span.start + 1; k < span.end; k++) {
            if (steps[k].kind === "member") roles[k] = { kind: "hidden" };
        }
    }
    return roles;
}
