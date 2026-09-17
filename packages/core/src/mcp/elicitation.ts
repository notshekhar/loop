/**
 * Elicitation: a server asking the USER a question in the middle of a tool call.
 *
 * It is the one place in MCP where the server drives the interface, and the
 * AI SDK will answer `elicitation/create` with "no elicitation handler
 * registered on client" until something registers one — so a server built
 * around a mid-call confirmation (a deploy that asks which environment, a
 * migration that asks before it writes) simply could not complete its call.
 *
 * Core owns the schema and the result; the interface lives in the CLI, behind
 * the same bridge pattern the `ask` tool uses. Nothing is registered in print
 * mode or in a subagent — there is no one there to ask — and in that case the
 * request is DECLINED rather than left hanging, which is the answer the spec
 * has for a client that can't present the question.
 */

/** One field of a server's requested schema, flattened for a UI to render. */
export interface ElicitationField {
    name: string;
    type: "string" | "number" | "integer" | "boolean" | "enum";
    title?: string;
    description?: string;
    required: boolean;
    /** Allowed values, for `enum`. `enumNames` supplies their labels when present. */
    options?: Array<{ value: string; label: string }>;
    default?: string | number | boolean;
    format?: string;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
}

export interface ElicitationRequestInfo {
    /** The server doing the asking — always shown, so it is never ambiguous who wants this. */
    server: string;
    message: string;
    fields: ElicitationField[];
}

/** Mirrors the protocol's three outcomes exactly. */
export type ElicitationOutcome =
    | { action: "accept"; content: Record<string, string | number | boolean> }
    | { action: "decline" }
    | { action: "cancel" };

export interface McpElicitationBridge {
    /** Present the request and resolve with what the user chose. Must never reject. */
    elicit(request: ElicitationRequestInfo, opts?: { signal?: AbortSignal }): Promise<ElicitationOutcome>;
}

let bridge: McpElicitationBridge | null = null;

/** The CLI (interactive mode only) registers its implementation at startup. */
export function setMcpElicitationBridge(b: McpElicitationBridge | null): void {
    bridge = b;
}

export function getMcpElicitationBridge(): McpElicitationBridge | null {
    return bridge;
}

export function isElicitationAvailable(): boolean {
    return bridge !== null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Flatten a server's `requestedSchema` into fields.
 *
 * The spec restricts this to a flat object of primitives precisely so a client
 * can render it without implementing JSON Schema, and anything outside that is
 * dropped rather than guessed at: a nested object rendered as a text box
 * collects a string the server will reject anyway.
 */
export function parseElicitationSchema(schema: unknown): ElicitationField[] {
    const root = asRecord(schema);
    const properties = asRecord(root?.properties);
    if (!properties) return [];
    const required = new Set(Array.isArray(root?.required) ? root.required.filter((r) => typeof r === "string") : []);

    const fields: ElicitationField[] = [];
    for (const [name, raw] of Object.entries(properties)) {
        const prop = asRecord(raw);
        if (!prop) continue;
        const title = optionalString(prop.title);
        const description = optionalString(prop.description);
        const common = {
            name,
            required: required.has(name),
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
        };

        if (Array.isArray(prop.enum)) {
            const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
            const options = prop.enum
                .filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value))
                .map((value, index) => ({
                    value: String(value),
                    label: optionalString(names[index]) ?? String(value),
                }));
            if (options.length === 0) continue;
            fields.push({
                ...common,
                type: "enum",
                options,
                ...(prop.default !== undefined ? { default: prop.default as string } : {}),
            });
            continue;
        }

        const type = optionalString(prop.type);
        if (type === "boolean") {
            fields.push({
                ...common,
                type: "boolean",
                ...(typeof prop.default === "boolean" ? { default: prop.default } : {}),
            });
            continue;
        }
        if (type === "number" || type === "integer") {
            fields.push({
                ...common,
                type,
                ...(optionalNumber(prop.default) !== undefined ? { default: prop.default as number } : {}),
                ...(optionalNumber(prop.minimum) !== undefined ? { minimum: prop.minimum as number } : {}),
                ...(optionalNumber(prop.maximum) !== undefined ? { maximum: prop.maximum as number } : {}),
            });
            continue;
        }
        if (type === "string") {
            fields.push({
                ...common,
                type: "string",
                ...(optionalString(prop.default) ? { default: prop.default as string } : {}),
                ...(optionalString(prop.format) ? { format: prop.format as string } : {}),
                ...(optionalNumber(prop.minLength) !== undefined ? { minLength: prop.minLength as number } : {}),
                ...(optionalNumber(prop.maxLength) !== undefined ? { maxLength: prop.maxLength as number } : {}),
            });
        }
        // Anything else (object, array, unknown) is deliberately skipped.
    }
    return fields;
}

/**
 * Turn what the user typed into what the server declared it wanted.
 *
 * A number field must come back as a number, not the string the text box
 * produced — a server validating its own schema rejects `"3"` for
 * `{"type":"number"}`, and the failure surfaces as an unexplained tool error
 * long after the user has moved on. Fields left empty are omitted entirely
 * rather than sent as "", which is a value, and a meaningful one.
 */
export function coerceElicitationValues(
    fields: ElicitationField[],
    raw: Record<string, string>,
): { content: Record<string, string | number | boolean>; errors: string[] } {
    const content: Record<string, string | number | boolean> = {};
    const errors: string[] = [];

    for (const field of fields) {
        const value = raw[field.name];
        if (value === undefined || value === "") {
            if (field.required) errors.push(`${field.name} is required`);
            continue;
        }
        if (field.type === "boolean") {
            const truthy = ["true", "yes", "y", "1"].includes(value.toLowerCase());
            const falsy = ["false", "no", "n", "0"].includes(value.toLowerCase());
            if (!truthy && !falsy) {
                errors.push(`${field.name} must be true or false`);
                continue;
            }
            content[field.name] = truthy;
            continue;
        }
        if (field.type === "number" || field.type === "integer") {
            const num = Number(value);
            if (!Number.isFinite(num)) {
                errors.push(`${field.name} must be a number`);
                continue;
            }
            if (field.type === "integer" && !Number.isInteger(num)) {
                errors.push(`${field.name} must be a whole number`);
                continue;
            }
            if (field.minimum !== undefined && num < field.minimum) {
                errors.push(`${field.name} must be at least ${field.minimum}`);
                continue;
            }
            if (field.maximum !== undefined && num > field.maximum) {
                errors.push(`${field.name} must be at most ${field.maximum}`);
                continue;
            }
            content[field.name] = num;
            continue;
        }
        if (field.type === "enum") {
            const match = field.options?.find((o) => o.value === value || o.label === value);
            if (!match) {
                errors.push(`${field.name} must be one of: ${field.options?.map((o) => o.value).join(", ")}`);
                continue;
            }
            content[field.name] = match.value;
            continue;
        }
        if (field.minLength !== undefined && value.length < field.minLength) {
            errors.push(`${field.name} must be at least ${field.minLength} characters`);
            continue;
        }
        if (field.maxLength !== undefined && value.length > field.maxLength) {
            errors.push(`${field.name} must be at most ${field.maxLength} characters`);
            continue;
        }
        content[field.name] = value;
    }
    return { content, errors };
}

/**
 * Answer one `elicitation/create`.
 *
 * With no bridge — print mode, RPC, a subagent — this declines immediately.
 * Leaving the request unanswered would hang the server's tool call until the
 * call timeout fires, turning "nobody can answer you" into a two-minute stall
 * and an error that says nothing about why.
 */
export async function handleElicitation(
    server: string,
    params: { message?: unknown; requestedSchema?: unknown },
    opts: { signal?: AbortSignal } = {},
): Promise<ElicitationOutcome> {
    const active = bridge;
    if (!active) return { action: "decline" };
    const request: ElicitationRequestInfo = {
        server,
        message: typeof params.message === "string" ? params.message : "",
        fields: parseElicitationSchema(params.requestedSchema),
    };
    try {
        return await active.elicit(request, opts);
    } catch {
        // A bridge that throws must not leave the server waiting.
        return { action: "cancel" };
    }
}
