/**
 * Interactive answers to `elicitation/create` — an MCP server asking the user
 * a question in the middle of its own tool call.
 *
 * Deliberately built from the plain selector/prompt helpers rather than the
 * ask tool's flow: the model is not asking here, a SERVER is, and the two
 * should not look alike. Every screen names the server, because "who wants to
 * know this" is the one thing the user must not have to guess before typing an
 * answer into it.
 *
 * Registered in app.ts, interactive mode only. Print mode, RPC and subagents
 * register nothing, and core declines those requests outright instead of
 * leaving the server's tool call hanging.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    coerceElicitationValues,
    type ElicitationField,
    type ElicitationOutcome,
    type ElicitationRequestInfo,
    type McpElicitationBridge,
} from "@notshekhar/loop-core";

export interface McpElicitDeps {
    selectOnce: (items: SelectItem[], title?: string) => Promise<SelectItem | null>;
    promptOnce: (label?: string, initial?: string) => Promise<string>;
    /** Shown in the transcript when a request is refused, so the outcome isn't silent. */
    say: (text: string) => void;
}

/** `title — description` where both exist, so the field's own words come first. */
function fieldLabel(field: ElicitationField): string {
    const name = field.title ?? field.name;
    const required = field.required ? "" : " (optional)";
    return field.description ? `${name}${required} — ${field.description}` : `${name}${required}`;
}

const CANCEL = Symbol("cancel");

/** One field's raw string answer, or CANCEL when the user pressed Esc. */
async function askField(deps: McpElicitDeps, server: string, field: ElicitationField): Promise<string | typeof CANCEL> {
    const title = `${server} asks: ${fieldLabel(field)}`;

    if (field.type === "enum") {
        const items = (field.options ?? []).map((o) => ({ value: o.value, label: o.label }));
        const chosen = await deps.selectOnce(items, title);
        return chosen ? chosen.value : CANCEL;
    }
    if (field.type === "boolean") {
        const chosen = await deps.selectOnce(
            [
                { value: "true", label: "yes" },
                { value: "false", label: "no" },
            ],
            title,
        );
        return chosen ? chosen.value : CANCEL;
    }
    // Free text (and numbers, validated on the way out by coerceElicitationValues).
    const initial = field.default !== undefined ? String(field.default) : "";
    const typed = await deps.promptOnce(title, initial);
    // An optional field left blank is an answer — it is omitted from content.
    // A required one left blank is not, and re-asking beats sending "".
    if (!typed.trim() && field.required) return CANCEL;
    return typed.trim();
}

export function createMcpElicitationBridge(deps: McpElicitDeps): McpElicitationBridge {
    return {
        async elicit(request: ElicitationRequestInfo, opts): Promise<ElicitationOutcome> {
            const { server, message, fields } = request;

            // A request with no fields is a confirmation, and asking for
            // "input" would be nonsense — it gets a straight yes/no.
            if (fields.length === 0) {
                const choice = await deps.selectOnce(
                    [
                        { value: "accept", label: "confirm" },
                        { value: "decline", label: "decline" },
                    ],
                    `${server}: ${message || "needs confirmation"}`,
                );
                if (!choice) return { action: "cancel" };
                return choice.value === "accept" ? { action: "accept", content: {} } : { action: "decline" };
            }

            const raw: Record<string, string> = {};
            // Two passes at most: one to collect, one to fix whatever failed
            // the server's own declared constraints. A third would be a loop
            // the user cannot leave except by cancelling.
            for (let attempt = 0; attempt < 2; attempt++) {
                const pending = attempt === 0 ? fields : fields.filter((f) => !(f.name in raw) || raw[f.name] === "");
                for (const field of pending) {
                    if (opts?.signal?.aborted) return { action: "cancel" };
                    const answer = await askField(deps, server, field);
                    if (answer === CANCEL) return { action: "cancel" };
                    raw[field.name] = answer;
                }
                const { content, errors } = coerceElicitationValues(fields, raw);
                if (errors.length === 0) {
                    const summary = Object.entries(content)
                        .map(([key, value]) => `${key}=${value}`)
                        .join("  ");
                    const choice = await deps.selectOnce(
                        [
                            { value: "accept", label: `send to ${server}`, description: summary || undefined },
                            { value: "decline", label: "decline — send nothing" },
                        ],
                        message || `Send these answers to ${server}?`,
                    );
                    if (!choice) return { action: "cancel" };
                    if (choice.value === "decline") return { action: "decline" };
                    return { action: "accept", content };
                }
                deps.say(`${server}: ${errors.join("; ")}`);
                // Clear only what failed, so the user re-types one field rather
                // than the whole form.
                for (const error of errors) {
                    const name = error.split(" ")[0];
                    if (name in raw) raw[name] = "";
                }
            }
            deps.say(`${server}: elicitation cancelled — answers did not match what the server asked for.`);
            return { action: "cancel" };
        },
    };
}
