/**
 * Interactive bash approval prompt (bashApprove setting). The core bash tool's
 * execute awaits BashApprovalBridge.confirm(); this module renders the command
 * plus a deny / allow-once / always-allow menu using the same building blocks
 * as selectors.ts. Registered via setBashApprovalBridge in app.ts —
 * interactive mode only, so print mode / RPC never prompt.
 *
 * Inside cmux the same prompt is also pushed to its Feed, so it can be
 * answered from the sidebar or the notification's buttons without coming back
 * to the terminal. The two answers race: the first one wins and closes the
 * other, because they answer the same question — the menu on screen is never
 * taken away by a remote decision that hasn't been made.
 */
import { Container, SelectList, type SelectItem, Text } from "@notshekhar/loop-tui";
import type { BashApprovalBridge, BashApprovalDecision, BashApprovalRequest } from "@notshekhar/loop-core";
import { cmux, type CmuxPermissionMode } from "./cmux-reporter";
import type { SelectorHost } from "./selectors";
import { DynamicBorder } from "./ui/messages";
import { getSelectListTheme } from "./ui/theme";
import { accent, dim, warnTitle } from "./ui/text";

/**
 * cmux's permission modes in loop's terms. "always"/"all"/"bypass" all mean
 * stop asking — which loop can only honour as a persisted rule when there are
 * patterns to persist; without them the honest reading is "yes, this time".
 */
function fromCmuxMode(mode: CmuxPermissionMode, canPersist: boolean): BashApprovalDecision {
    switch (mode) {
        case "deny":
            return "deny";
        case "always":
        case "all":
        case "bypass":
            return canPersist ? "always" : "once";
        default:
            return "once";
    }
}

/**
 * The persisted choices. Bash patterns are loop's own (per-project grants,
 * the denylist); an agent-tool's are rules the agent itself keeps, and it can
 * only keep allow rules — so there is no "never" for those.
 */
function persistItems(kind: string, patterns: string[]): SelectItem[] {
    const list = patterns.join(", ");
    if (kind === "tool") {
        return [{ value: "always", label: "always allow", description: `the agent stops asking for: ${list}` }];
    }
    return [
        { value: "always", label: "always allow (this project)", description: `stop asking here for: ${list}` },
        { value: "never", label: "never allow", description: `refuse and add to the denylist: ${list}` },
    ];
}

/** Keep the prompt compact: at most this many command lines, each capped. */
const MAX_COMMAND_LINES = 6;
const MAX_LINE_CHARS = 100;

export function createBashApprovalBridge(host: SelectorHost): BashApprovalBridge {
    const showPrompt = (req: BashApprovalRequest, signal: AbortSignal | undefined): Promise<BashApprovalDecision> =>
        new Promise((resolve) => {
            const kind = req.kind ?? "bash";
            // Path/plan prompts are once-or-deny only; bash and agent-tool
            // prompts offer the persisted always/never pair when there are
            // patterns to remember.
            const persistable = (kind === "bash" || kind === "tool") && req.patterns.length > 0;
            const onceLabel = kind === "bash" ? "allow once" : kind === "exit-plan" ? "implement it" : "allow";
            const items: SelectItem[] = [
                {
                    value: "once",
                    label: onceLabel,
                    description:
                        kind === "exit-plan"
                            ? "approve the plan — plan mode off, the agent builds it now"
                            : "approve this time; ask again next time",
                },
                ...(persistable ? persistItems(kind, req.patterns) : []),
                kind === "exit-plan"
                    ? {
                          value: "deny",
                          label: "keep planning",
                          description: "stay in plan mode — tell the agent what to change",
                      }
                    : { value: "deny", label: "deny", description: "refuse — the agent is told you declined" },
            ];
            const headline =
                kind === "path"
                    ? " [permission] allow this file access?"
                    : kind === "tool"
                      ? " [permission] allow this tool call?"
                      : kind === "plan"
                        ? " [plan] the agent wants to enter plan mode"
                        : kind === "exit-plan"
                          ? " [plan] plan ready — leave plan mode and implement it?"
                          : " [bash] run this command?";
            const list = new SelectList(items, items.length, getSelectListTheme());
            const wrapper = new Container();
            wrapper.addChild(new Text(warnTitle(headline), 0, 0));
            if (req.title) wrapper.addChild(new Text(dim(` ${req.title}`), 0, 0));
            const lines = req.command.split("\n");
            for (const line of lines.slice(0, MAX_COMMAND_LINES)) {
                const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
                wrapper.addChild(new Text(accent(` ${shown}`), 0, 0));
            }
            if (lines.length > MAX_COMMAND_LINES) {
                wrapper.addChild(new Text(dim(` … ${lines.length - MAX_COMMAND_LINES} more lines`), 0, 0));
            }
            wrapper.addChild(new DynamicBorder());
            wrapper.addChild(list);
            wrapper.addChild(new DynamicBorder());
            wrapper.addChild(
                new Text(
                    dim(
                        kind === "exit-plan"
                            ? " ↑↓ navigate · Enter select · Esc keeps plan mode on"
                            : " ↑↓ navigate · Enter select · Esc denies",
                    ),
                    0,
                    0,
                ),
            );

            const statusLabel =
                kind === "path"
                    ? "file access approval"
                    : kind === "tool"
                      ? "tool approval"
                      : kind === "plan" || kind === "exit-plan"
                        ? "plan approval"
                        : "bash approval";
            const close = host.showSelector(wrapper, list, statusLabel);
            let done = false;
            // Withdraws the cmux card the moment the TUI answers.
            const remote = new AbortController();
            const onAbort = () => finish("deny");
            const finish = (v: BashApprovalDecision) => {
                if (done) return;
                done = true;
                signal?.removeEventListener("abort", onAbort);
                remote.abort();
                close();
                resolve(v);
            };
            signal?.addEventListener("abort", onAbort);
            list.onSelect = (item) => finish(item.value as BashApprovalDecision);
            list.onCancel = () => finish("deny");

            // cmux Feed card for the same prompt (no-op outside cmux). An
            // exit-plan approval goes as a plan card, which is the one cmux
            // renders with the plan text and its own approve/refine choices.
            const canPersist = items.some((i) => i.value === "always");
            void cmux()
                .requestApproval(
                    {
                        kind,
                        toolName:
                            kind === "bash"
                                ? "bash"
                                : kind === "path"
                                  ? "file"
                                  : kind === "tool"
                                    ? "tool"
                                    : "exit_plan_mode",
                        body: req.command,
                        title: req.title,
                        patterns: req.patterns,
                    },
                    remote.signal,
                )
                .then((decision) => {
                    if (!decision || done) return;
                    if (decision.kind === "permission") {
                        finish(fromCmuxMode(decision.mode, canPersist));
                        return;
                    }
                    // Plan card: every approving mode means "build it"; deny
                    // and ultraplan (which loop has no equivalent for) both
                    // mean keep planning, so the agent hears a refusal.
                    finish(decision.mode === "deny" || decision.mode === "ultraplan" ? "deny" : "once");
                })
                .catch(() => {});
        });

    // Serialize concurrent confirm() calls (parallel bash tool calls in one
    // step, or subagents) — there is only one showSelector slot.
    let chain: Promise<unknown> = Promise.resolve();

    return {
        confirm(req, opts) {
            const signal = opts?.signal;
            const run = () => (signal?.aborted ? Promise.resolve("deny" as const) : showPrompt(req, signal));
            const p = chain.then(run, run);
            chain = p.catch(() => {});
            return p;
        },
    };
}
